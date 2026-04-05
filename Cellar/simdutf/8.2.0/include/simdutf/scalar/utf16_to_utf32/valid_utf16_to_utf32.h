#ifndef SIMDUTF_VALID_UTF16_TO_UTF32_H
#define SIMDUTF_VALID_UTF16_TO_UTF32_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf16_to_utf32 {

template <endianness big_endian>
simdutf_constexpr23 size_t convert_valid(const char16_t *data, size_t len,
                                         char32_t *utf32_output) {
  size_t pos = 0;
  char32_t *start{utf32_output};
  while (pos < len) {
    uint16_t word =
        !match_system(big_endian) ? u16_swap_bytes(data[pos]) : data[pos];
    if ((word & 0xF800) != 0xD800) {
      // No surrogate pair, extend 16-bit word to 32-bit word
      *utf32_output++ = char32_t(word);
      pos++;
    } else {
      // must be a surrogate pair
      uint16_t diff = uint16_t(word - 0xD800);
      if (pos + 1 >= len) {
        return 0;
      } // minimal bound checking
      uint16_t next_word = !match_system(big_endian)
                               ? u16_swap_bytes(data[pos + 1])
                               : data[pos + 1];
      uint16_t diff2 = uint16_t(next_word - 0xDC00);
      uint32_t value = (diff << 10) + diff2 + 0x10000;
      *utf32_output++ = char32_t(value);
      pos += 2;
    }
  }
  return utf32_output - start;
}

} // namespace utf16_to_utf32
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
