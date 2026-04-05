#ifndef SIMDUTF_ERROR_H
#define SIMDUTF_ERROR_H
namespace simdutf {

enum error_code {
  SUCCESS = 0,
  HEADER_BITS, // Any byte must have fewer than 5 header bits.
  TOO_SHORT,   // The leading byte must be followed by N-1 continuation bytes,
               // where N is the UTF-8 character length This is also the error
               // when the input is truncated.
  TOO_LONG,    // We either have too many consecutive continuation bytes or the
               // string starts with a continuation byte.
  OVERLONG, // The decoded character must be above U+7F for two-byte characters,
            // U+7FF for three-byte characters, and U+FFFF for four-byte
            // characters.
  TOO_LARGE, // The decoded character must be less than or equal to
             // U+10FFFF,less than or equal than U+7F for ASCII OR less than
             // equal than U+FF for Latin1
  SURROGATE, // The decoded character must be not be in U+D800...DFFF (UTF-8 or
             // UTF-32)
             // OR
             // a high surrogate must be followed by a low surrogate
             // and a low surrogate must be preceded by a high surrogate
             // (UTF-16)
             // OR
             // there must be no surrogate at all and one is
             // found (Latin1 functions)
             // OR
             // *specifically* for the function
             // utf8_length_from_utf16_with_replacement, a surrogate (whether
             // in error or not) has been found (I.e., whether we are in the
             // Basic Multilingual Plane or not).
  INVALID_BASE64_CHARACTER, // Found a character that cannot be part of a valid
                            // base64 string. This may include a misplaced
                            // padding character ('=').
  BASE64_INPUT_REMAINDER,   // The base64 input terminates with a single
                            // character, excluding padding (=). It is also used
                            // in strict mode when padding is not adequate.
  BASE64_EXTRA_BITS,        // The base64 input terminates with non-zero
                            // padding bits.
  OUTPUT_BUFFER_TOO_SMALL,  // The provided buffer is too small.
  OTHER                     // Not related to validation/transcoding.
};
#if SIMDUTF_CPLUSPLUS17
inline std::string_view error_to_string(error_code code) noexcept {
  switch (code) {
  case SUCCESS:
    return "SUCCESS";
  case HEADER_BITS:
    return "HEADER_BITS";
  case TOO_SHORT:
    return "TOO_SHORT";
  case TOO_LONG:
    return "TOO_LONG";
  case OVERLONG:
    return "OVERLONG";
  case TOO_LARGE:
    return "TOO_LARGE";
  case SURROGATE:
    return "SURROGATE";
  case INVALID_BASE64_CHARACTER:
    return "INVALID_BASE64_CHARACTER";
  case BASE64_INPUT_REMAINDER:
    return "BASE64_INPUT_REMAINDER";
  case BASE64_EXTRA_BITS:
    return "BASE64_EXTRA_BITS";
  case OUTPUT_BUFFER_TOO_SMALL:
    return "OUTPUT_BUFFER_TOO_SMALL";
  default:
    return "OTHER";
  }
}
#endif

struct result {
  error_code error;
  size_t count; // In case of error, indicates the position of the error. In
                // case of success, indicates the number of code units
                // validated/written.

  simdutf_really_inline simdutf_constexpr23 result() noexcept
      : error{error_code::SUCCESS}, count{0} {}

  simdutf_really_inline simdutf_constexpr23 result(error_code err,
                                                   size_t pos) noexcept
      : error{err}, count{pos} {}

  simdutf_really_inline simdutf_constexpr23 bool is_ok() const noexcept {
    return error == error_code::SUCCESS;
  }

  simdutf_really_inline simdutf_constexpr23 bool is_err() const noexcept {
    return error != error_code::SUCCESS;
  }
};

struct full_result {
  error_code error;
  size_t input_count;
  size_t output_count;
  bool padding_error = false; // true if the error is due to padding, only
                              // meaningful when error is not SUCCESS

  simdutf_really_inline simdutf_constexpr23 full_result() noexcept
      : error{error_code::SUCCESS}, input_count{0}, output_count{0} {}

  simdutf_really_inline simdutf_constexpr23 full_result(error_code err,
                                                        size_t pos_in,
                                                        size_t pos_out) noexcept
      : error{err}, input_count{pos_in}, output_count{pos_out} {}
  simdutf_really_inline simdutf_constexpr23 full_result(
      error_code err, size_t pos_in, size_t pos_out, bool padding_err) noexcept
      : error{err}, input_count{pos_in}, output_count{pos_out},
        padding_error{padding_err} {}

  simdutf_really_inline simdutf_constexpr23 operator result() const noexcept {
    if (error == error_code::SUCCESS) {
      return result{error, output_count};
    } else {
      return result{error, input_count};
    }
  }
};

} // namespace simdutf
#endif
