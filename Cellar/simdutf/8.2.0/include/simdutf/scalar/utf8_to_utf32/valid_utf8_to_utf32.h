#ifndef SIMDUTF_VALID_UTF8_TO_UTF32_H
#define SIMDUTF_VALID_UTF8_TO_UTF32_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf8_to_utf32 {

template <typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 size_t convert_valid(InputPtr data, size_t len,
                                         char32_t *utf32_output) {
  size_t pos = 0;
  char32_t *start{utf32_output};
  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    {
      // try to convert the next block of 8 ASCII bytes
      if (pos + 8 <= len) { // if it is safe to read 8 more bytes, check that
                            // they are ascii
        uint64_t v;
        ::memcpy(&v, data + pos, sizeof(uint64_t));
        if ((v & 0x8080808080808080) == 0) {
          size_t final_pos = pos + 8;
          while (pos < final_pos) {
            *utf32_output++ = uint8_t(data[pos]);
            pos++;
          }
          continue;
        }
      }
    }
    auto leading_byte = uint8_t(data[pos]); // leading byte
    if (leading_byte < 0b10000000) {
      // converting one ASCII byte !!!
      *utf32_output++ = char32_t(leading_byte);
      pos++;
    } else if ((leading_byte & 0b11100000) == 0b11000000) {
      // We have a two-byte UTF-8
      if (pos + 1 >= len) {
        break;
      } // minimal bound checking
      *utf32_output++ = char32_t(((leading_byte & 0b00011111) << 6) |
                                 (uint8_t(data[pos + 1]) & 0b00111111));
      pos += 2;
    } else if ((leading_byte & 0b11110000) == 0b11100000) {
      // We have a three-byte UTF-8
      if (pos + 2 >= len) {
        break;
      } // minimal bound checking
      *utf32_output++ = char32_t(((leading_byte & 0b00001111) << 12) |
                                 ((uint8_t(data[pos + 1]) & 0b00111111) << 6) |
                                 (uint8_t(data[pos + 2]) & 0b00111111));
      pos += 3;
    } else if ((leading_byte & 0b11111000) == 0b11110000) { // 0b11110000
      // we have a 4-byte UTF-8 word.
      if (pos + 3 >= len) {
        break;
      } // minimal bound checking
      uint32_t code_word = ((leading_byte & 0b00000111) << 18) |
                           ((uint8_t(data[pos + 1]) & 0b00111111) << 12) |
                           ((uint8_t(data[pos + 2]) & 0b00111111) << 6) |
                           (uint8_t(data[pos + 3]) & 0b00111111);
      *utf32_output++ = char32_t(code_word);
      pos += 4;
    } else {
      // we may have a continuation but we do not do error checking
      return 0;
    }
  }
  return utf32_output - start;
}

} // namespace utf8_to_utf32
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
