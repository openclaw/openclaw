#ifndef SIMDUTF_BASE64_IMPLEMENTATION_H
#define SIMDUTF_BASE64_IMPLEMENTATION_H

// this is not part of the public api

namespace simdutf {

template <typename chartype>
simdutf_warn_unused simdutf_constexpr23 result slow_base64_to_binary_safe_impl(
    const chartype *input, size_t length, char *output, size_t &outlen,
    base64_options options,
    last_chunk_handling_options last_chunk_options) noexcept {
  const bool ignore_garbage = (options & base64_default_accept_garbage) != 0;
  auto ri = simdutf::scalar::base64::find_end(input, length, options);
  size_t equallocation = ri.equallocation;
  size_t equalsigns = ri.equalsigns;
  length = ri.srclen;
  size_t full_input_length = ri.full_input_length;
  (void)full_input_length;
  if (length == 0) {
    outlen = 0;
    if (!ignore_garbage && equalsigns > 0) {
      return {INVALID_BASE64_CHARACTER, equallocation};
    }
    return {SUCCESS, 0};
  }

  // The parameters of base64_tail_decode_safe are:
  // - dst: the output buffer
  // - outlen: the size of the output buffer
  // - srcr: the input buffer
  // - length: the size of the input buffer
  // - padded_characters: the number of padding characters
  // - options: the options for the base64 decoder
  // - last_chunk_options: the options for the last chunk
  // The function will return the number of bytes written to the output buffer
  // and the number of bytes read from the input buffer.
  // The function will also return an error code if the input buffer is not
  // valid base64.
  full_result r = scalar::base64::base64_tail_decode_safe(
      output, outlen, input, length, equalsigns, options, last_chunk_options);
  r = scalar::base64::patch_tail_result(r, 0, 0, equallocation,
                                        full_input_length, last_chunk_options);
  outlen = r.output_count;
  if (!is_partial(last_chunk_options) && r.error == error_code::SUCCESS &&
      equalsigns > 0) {
    // additional checks
    if ((outlen % 3 == 0) || ((outlen % 3) + 1 + equalsigns != 4)) {
      r.error = error_code::INVALID_BASE64_CHARACTER;
    }
  }
  return {r.error, r.input_count}; // we cannot return r itself because it gets
                                   // converted to error/output_count
}

template <typename chartype>
simdutf_warn_unused simdutf_constexpr23 result base64_to_binary_safe_impl(
    const chartype *input, size_t length, char *output, size_t &outlen,
    base64_options options,
    last_chunk_handling_options last_chunk_handling_options,
    bool decode_up_to_bad_char) noexcept {
  static_assert(std::is_same<chartype, char>::value ||
                    std::is_same<chartype, char16_t>::value,
                "Only char and char16_t are supported.");
  size_t remaining_input_length = length;
  size_t remaining_output_length = outlen;
  size_t input_position = 0;
  size_t output_position = 0;

  // We also do a first pass using the fast path to decode as much as possible
  size_t safe_input = (std::min)(
      remaining_input_length,
      base64_length_from_binary(remaining_output_length / 3 * 3, options));
  bool done_with_partial = (safe_input == remaining_input_length);
  simdutf::full_result r;

#if SIMDUTF_CPLUSPLUS23
  if consteval {
    r = scalar::base64::base64_to_binary_details_impl(
        input + input_position, safe_input, output + output_position, options,
        done_with_partial
            ? last_chunk_handling_options
            : simdutf::last_chunk_handling_options::only_full_chunks);
  } else
#endif
  {
    r = get_active_implementation()->base64_to_binary_details(
        input + input_position, safe_input, output + output_position, options,
        done_with_partial
            ? last_chunk_handling_options
            : simdutf::last_chunk_handling_options::only_full_chunks);
  }
  simdutf_log_assert(r.input_count <= safe_input,
                     "You should not read more than safe_input");
  simdutf_log_assert(r.output_count <= remaining_output_length,
                     "You should not write more than remaining_output_length");
  // Technically redundant, but we want to be explicit about it.
  input_position += r.input_count;
  output_position += r.output_count;
  remaining_input_length -= r.input_count;
  remaining_output_length -= r.output_count;
  if (r.error != simdutf::error_code::SUCCESS) {
    // There is an error. We return.
    if (decode_up_to_bad_char &&
        r.error == error_code::INVALID_BASE64_CHARACTER) {
      return slow_base64_to_binary_safe_impl(
          input, length, output, outlen, options, last_chunk_handling_options);
    }
    outlen = output_position;
    return {r.error, input_position};
  }

  if (done_with_partial) {
    // We are done. We have decoded everything.
    outlen = output_position;
    return {simdutf::error_code::SUCCESS, input_position};
  }
  // We have decoded some data, but we still have some data to decode.
  // We need to decode the rest of the input buffer.
  r = simdutf::scalar::base64::base64_to_binary_details_safe_impl(
      input + input_position, remaining_input_length, output + output_position,
      remaining_output_length, options, last_chunk_handling_options);
  input_position += r.input_count;
  output_position += r.output_count;
  remaining_input_length -= r.input_count;
  remaining_output_length -= r.output_count;

  if (r.error != simdutf::error_code::SUCCESS) {
    // There is an error. We return.
    if (decode_up_to_bad_char &&
        r.error == error_code::INVALID_BASE64_CHARACTER) {
      return slow_base64_to_binary_safe_impl(
          input, length, output, outlen, options, last_chunk_handling_options);
    }
    outlen = output_position;
    return {r.error, input_position};
  }
  if (input_position < length) {
    // We cannot process the entire input in one go, so we need to
    // process it in two steps: first the fast path, then the slow path.
    // In some cases, the processing might 'eat up' trailing ignorable
    // characters in the fast path, but that can be a problem.
    // suppose we have just white space followed by a single base64 character.
    // If we first process the white space with the fast path, it will
    // eat all of it. But, by the JavaScript standard, we should consume
    // no character. See
    // https://tc39.es/proposal-arraybuffer-base64/spec/#sec-frombase64
    while (input_position > 0 &&
           base64_ignorable(input[input_position - 1], options)) {
      input_position--;
    }
  }
  outlen = output_position;
  return {simdutf::error_code::SUCCESS, input_position};
}

} // namespace simdutf
#endif // SIMDUTF_BASE64_IMPLEMENTATION_H
