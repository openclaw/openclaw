#ifndef SIMDUTF_VALID_UTF16_TO_LATIN1_H
#define SIMDUTF_VALID_UTF16_TO_LATIN1_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf16_to_latin1 {

template <endianness big_endian, class InputIterator, class OutputIterator>
simdutf_constexpr23 inline size_t
convert_valid_impl(InputIterator data, size_t len,
                   OutputIterator latin_output) {
  static_assert(
      std::is_same<typename std::decay<decltype(*data)>::type, uint16_t>::value,
      "must decay to uint16_t");
  size_t pos = 0;
  const auto start = latin_output;
  uint16_t word = 0;

  while (pos < len) {
    word = !match_system(big_endian) ? u16_swap_bytes(data[pos]) : data[pos];
    *latin_output++ = char(word);
    pos++;
  }

  return latin_output - start;
}

template <endianness big_endian>
simdutf_really_inline size_t convert_valid(const char16_t *buf, size_t len,
                                           char *latin_output) {
  return convert_valid_impl<big_endian>(reinterpret_cast<const uint16_t *>(buf),
                                        len, latin_output);
}
} // namespace utf16_to_latin1
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
