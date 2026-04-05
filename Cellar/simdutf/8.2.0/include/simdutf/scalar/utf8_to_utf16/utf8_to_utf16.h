#ifndef SIMDUTF_UTF8_TO_UTF16_H
#define SIMDUTF_UTF8_TO_UTF16_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf8_to_utf16 {

template <endianness big_endian, typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   char16_t *utf16_output) {
  size_t pos = 0;
  char16_t *start{utf16_output};
  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    // try to convert the next block of 16 ASCII bytes
    {
      if (pos + 16 <= len) { // if it is safe to read 16 more bytes, check that
                             // they are ascii
        uint64_t v1;
        ::memcpy(&v1, data + pos, sizeof(uint64_t));
        uint64_t v2;
        ::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
        uint64_t v{v1 | v2};
        if ((v & 0x8080808080808080) == 0) {
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            *utf16_output++ = !match_system(big_endian)
                                  ? char16_t(u16_swap_bytes(data[pos]))
                                  : char16_t(data[pos]);
            pos++;
          }
          continue;
        }
      }
    }

    uint8_t leading_byte = data[pos]; // leading byte
    if (leading_byte < 0b10000000) {
      // converting one ASCII byte !!!
      *utf16_output++ = !match_system(big_endian)
                            ? char16_t(u16_swap_bytes(leading_byte))
                            : char16_t(leading_byte);
      pos++;
    } else if ((leading_byte & 0b11100000) == 0b11000000) {
      // We have a two-byte UTF-8, it should become
      // a single UTF-16 word.
      if (pos + 1 >= len) {
        return 0;
      } // minimal bound checking
      if ((data[pos + 1] & 0b11000000) != 0b10000000) {
        return 0;
      }
      // range check
      uint32_t code_point =
          (leading_byte & 0b00011111) << 6 | (data[pos + 1] & 0b00111111);
      if (code_point < 0x80 || 0x7ff < code_point) {
        return 0;
      }
      if simdutf_constexpr (!match_system(big_endian)) {
        code_point = uint32_t(u16_swap_bytes(uint16_t(code_point)));
      }
      *utf16_output++ = char16_t(code_point);
      pos += 2;
    } else if ((leading_byte & 0b11110000) == 0b11100000) {
      // We have a three-byte UTF-8, it should become
      // a single UTF-16 word.
      if (pos + 2 >= len) {
        return 0;
      } // minimal bound checking

      if ((data[pos + 1] & 0b11000000) != 0b10000000) {
        return 0;
      }
      if ((data[pos + 2] & 0b11000000) != 0b10000000) {
        return 0;
      }
      // range check
      uint32_t code_point = (leading_byte & 0b00001111) << 12 |
                            (data[pos + 1] & 0b00111111) << 6 |
                            (data[pos + 2] & 0b00111111);
      if (code_point < 0x800 || 0xffff < code_point ||
          (0xd7ff < code_point && code_point < 0xe000)) {
        return 0;
      }
      if simdutf_constexpr (!match_system(big_endian)) {
        code_point = uint32_t(u16_swap_bytes(uint16_t(code_point)));
      }
      *utf16_output++ = char16_t(code_point);
      pos += 3;
    } else if ((leading_byte & 0b11111000) == 0b11110000) { // 0b11110000
      // we have a 4-byte UTF-8 word.
      if (pos + 3 >= len) {
        return 0;
      } // minimal bound checking
      if ((data[pos + 1] & 0b11000000) != 0b10000000) {
        return 0;
      }
      if ((data[pos + 2] & 0b11000000) != 0b10000000) {
        return 0;
      }
      if ((data[pos + 3] & 0b11000000) != 0b10000000) {
        return 0;
      }

      // range check
      uint32_t code_point = (leading_byte & 0b00000111) << 18 |
                            (data[pos + 1] & 0b00111111) << 12 |
                            (data[pos + 2] & 0b00111111) << 6 |
                            (data[pos + 3] & 0b00111111);
      if (code_point <= 0xffff || 0x10ffff < code_point) {
        return 0;
      }
      code_point -= 0x10000;
      uint16_t high_surrogate = uint16_t(0xD800 + (code_point >> 10));
      uint16_t low_surrogate = uint16_t(0xDC00 + (code_point & 0x3FF));
      if simdutf_constexpr (!match_system(big_endian)) {
        high_surrogate = u16_swap_bytes(high_surrogate);
        low_surrogate = u16_swap_bytes(low_surrogate);
      }
      *utf16_output++ = char16_t(high_surrogate);
      *utf16_output++ = char16_t(low_surrogate);
      pos += 4;
    } else {
      return 0;
    }
  }
  return utf16_output - start;
}

template <endianness big_endian, typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 result convert_with_errors(InputPtr data, size_t len,
                                               char16_t *utf16_output) {
  size_t pos = 0;
  char16_t *start{utf16_output};
  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    {
      // try to convert the next block of 16 ASCII bytes
      if (pos + 16 <= len) { // if it is safe to read 16 more bytes, check that
                             // they are ascii
        uint64_t v1;
        ::memcpy(&v1, data + pos, sizeof(uint64_t));
        uint64_t v2;
        ::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
        uint64_t v{v1 | v2};
        if ((v & 0x8080808080808080) == 0) {
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            const char16_t byte = uint8_t(data[pos]);
            *utf16_output++ =
                !match_system(big_endian) ? u16_swap_bytes(byte) : byte;
            pos++;
          }
          continue;
        }
      }
    }

    auto leading_byte = uint8_t(data[pos]); // leading byte
    if (leading_byte < 0b10000000) {
      // converting one ASCII byte !!!
      *utf16_output++ = !match_system(big_endian)
                            ? char16_t(u16_swap_bytes(leading_byte))
                            : char16_t(leading_byte);
      pos++;
    } else if ((leading_byte & 0b11100000) == 0b11000000) {
      // We have a two-byte UTF-8, it should become
      // a single UTF-16 word.
      if (pos + 1 >= len) {
        return result(error_code::TOO_SHORT, pos);
      } // minimal bound checking
      if ((uint8_t(data[pos + 1]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }
      // range check
      uint32_t code_point = (leading_byte & 0b00011111) << 6 |
                            (uint8_t(data[pos + 1]) & 0b00111111);
      if (code_point < 0x80 || 0x7ff < code_point) {
        return result(error_code::OVERLONG, pos);
      }
      if simdutf_constexpr (!match_system(big_endian)) {
        code_point = uint32_t(u16_swap_bytes(uint16_t(code_point)));
      }
      *utf16_output++ = char16_t(code_point);
      pos += 2;
    } else if ((leading_byte & 0b11110000) == 0b11100000) {
      // We have a three-byte UTF-8, it should become
      // a single UTF-16 word.
      if (pos + 2 >= len) {
        return result(error_code::TOO_SHORT, pos);
      } // minimal bound checking

      if ((uint8_t(data[pos + 1]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }
      if ((uint8_t(data[pos + 2]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }
      // range check
      uint32_t code_point = (leading_byte & 0b00001111) << 12 |
                            (uint8_t(data[pos + 1]) & 0b00111111) << 6 |
                            (uint8_t(data[pos + 2]) & 0b00111111);
      if ((code_point < 0x800) || (0xffff < code_point)) {
        return result(error_code::OVERLONG, pos);
      }
      if (0xd7ff < code_point && code_point < 0xe000) {
        return result(error_code::SURROGATE, pos);
      }
      if simdutf_constexpr (!match_system(big_endian)) {
        code_point = uint32_t(u16_swap_bytes(uint16_t(code_point)));
      }
      *utf16_output++ = char16_t(code_point);
      pos += 3;
    } else if ((leading_byte & 0b11111000) == 0b11110000) { // 0b11110000
      // we have a 4-byte UTF-8 word.
      if (pos + 3 >= len) {
        return result(error_code::TOO_SHORT, pos);
      } // minimal bound checking
      if ((uint8_t(data[pos + 1]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }
      if ((uint8_t(data[pos + 2]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }
      if ((uint8_t(data[pos + 3]) & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      }

      // range check
      uint32_t code_point = (leading_byte & 0b00000111) << 18 |
                            (uint8_t(data[pos + 1]) & 0b00111111) << 12 |
                            (uint8_t(data[pos + 2]) & 0b00111111) << 6 |
                            (uint8_t(data[pos + 3]) & 0b00111111);
      if (code_point <= 0xffff) {
        return result(error_code::OVERLONG, pos);
      }
      if (0x10ffff < code_point) {
        return result(error_code::TOO_LARGE, pos);
      }
      code_point -= 0x10000;
      uint16_t high_surrogate = uint16_t(0xD800 + (code_point >> 10));
      uint16_t low_surrogate = uint16_t(0xDC00 + (code_point & 0x3FF));
      if simdutf_constexpr (!match_system(big_endian)) {
        high_surrogate = u16_swap_bytes(high_surrogate);
        low_surrogate = u16_swap_bytes(low_surrogate);
      }
      *utf16_output++ = char16_t(high_surrogate);
      *utf16_output++ = char16_t(low_surrogate);
      pos += 4;
    } else {
      // we either have too many continuation bytes or an invalid leading byte
      if ((leading_byte & 0b11000000) == 0b10000000) {
        return result(error_code::TOO_LONG, pos);
      } else {
        return result(error_code::HEADER_BITS, pos);
      }
    }
  }
  return result(error_code::SUCCESS, utf16_output - start);
}

/**
 * When rewind_and_convert_with_errors is called, we are pointing at 'buf' and
 * we have up to len input bytes left, and we encountered some error. It is
 * possible that the error is at 'buf' exactly, but it could also be in the
 * previous bytes  (up to 3 bytes back).
 *
 * prior_bytes indicates how many bytes, prior to 'buf' may belong to the
 * current memory section and can be safely accessed. We prior_bytes to access
 * safely up to three bytes before 'buf'.
 *
 * The caller is responsible to ensure that len > 0.
 *
 * If the error is believed to have occurred prior to 'buf', the count value
 * contain in the result will be SIZE_T - 1, SIZE_T - 2, or SIZE_T - 3.
 */
template <endianness endian>
inline result rewind_and_convert_with_errors(size_t prior_bytes,
                                             const char *buf, size_t len,
                                             char16_t *utf16_output) {
  size_t extra_len{0};
  // We potentially need to go back in time and find a leading byte.
  // In theory '3' would be sufficient, but sometimes the error can go back
  // quite far.
  size_t how_far_back = prior_bytes;
  // size_t how_far_back = 3; // 3 bytes in the past + current position
  // if(how_far_back >= prior_bytes) { how_far_back = prior_bytes; }
  bool found_leading_bytes{false};
  // important: it is i <= how_far_back and not 'i < how_far_back'.
  for (size_t i = 0; i <= how_far_back; i++) {
    unsigned char byte = buf[-static_cast<std::ptrdiff_t>(i)];
    found_leading_bytes = ((byte & 0b11000000) != 0b10000000);
    if (found_leading_bytes) {
      if (i > 0 && byte < 128) {
        // If we had to go back and the leading byte is ascii
        // then we can stop right away.
        return result(error_code::TOO_LONG, 0 - i + 1);
      }
      buf -= i;
      extra_len = i;
      break;
    }
  }
  //
  // It is possible for this function to return a negative count in its result.
  // C++ Standard Section 18.1 defines size_t is in <cstddef> which is described
  // in C Standard as <stddef.h>. C Standard Section 4.1.5 defines size_t as an
  // unsigned integral type of the result of the sizeof operator
  //
  // An unsigned type will simply wrap round arithmetically (well defined).
  //
  if (!found_leading_bytes) {
    // If how_far_back == 3, we may have four consecutive continuation bytes!!!
    // [....] [continuation] [continuation] [continuation] | [buf is
    // continuation] Or we possibly have a stream that does not start with a
    // leading byte.
    return result(error_code::TOO_LONG, 0 - how_far_back);
  }
  result res = convert_with_errors<endian>(buf, len + extra_len, utf16_output);
  if (res.error) {
    res.count -= extra_len;
  }
  return res;
}

} // namespace utf8_to_utf16
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
