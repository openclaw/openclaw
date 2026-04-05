#ifndef SIMDUTF_UTF8_TO_LATIN1_H
#define SIMDUTF_UTF8_TO_LATIN1_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf8_to_latin1 {

template <typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_byte_like<InputPtr> &&
           simdutf::detail::indexes_into_byte_like<OutputPtr>)
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   OutputPtr latin_output) {
  size_t pos = 0;
  auto start = latin_output;

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
        uint64_t v{v1 | v2}; // We are only interested in these bits: 1000 1000
                             // 1000 1000 .... etc
        if ((v & 0x8080808080808080) ==
            0) { // if NONE of these are set, e.g. all of them are zero, then
                 // everything is ASCII
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            *latin_output++ = char(data[pos]);
            pos++;
          }
          continue;
        }
      }
    }

    // suppose it is not an all ASCII byte sequence
    uint8_t leading_byte = data[pos]; // leading byte
    if (leading_byte < 0b10000000) {
      // converting one ASCII byte !!!
      *latin_output++ = char(leading_byte);
      pos++;
    } else if ((leading_byte & 0b11100000) ==
               0b11000000) { // the first three bits indicate:
      // We have a two-byte UTF-8
      if (pos + 1 >= len) {
        return 0;
      } // minimal bound checking
      if ((data[pos + 1] & 0b11000000) != 0b10000000) {
        return 0;
      } // checks if the next byte is a valid continuation byte in UTF-8. A
        // valid continuation byte starts with 10.
      // range check -
      uint32_t code_point =
          (leading_byte & 0b00011111) << 6 |
          (data[pos + 1] &
           0b00111111); // assembles the Unicode code point from the two bytes.
                        // It does this by discarding the leading 110 and 10
                        // bits from the two bytes, shifting the remaining bits
                        // of the first byte, and then combining the results
                        // with a bitwise OR operation.
      if (code_point < 0x80 || 0xFF < code_point) {
        return 0; // We only care about the range 129-255 which is Non-ASCII
                  // latin1 characters. A code_point beneath 0x80 is invalid as
                  // it is already covered by bytes whose leading bit is zero.
      }
      *latin_output++ = char(code_point);
      pos += 2;
    } else {
      return 0;
    }
  }
  return latin_output - start;
}

template <typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 result convert_with_errors(InputPtr data, size_t len,
                                               char *latin_output) {
  size_t pos = 0;
  char *start{latin_output};

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
        uint64_t v{v1 | v2}; // We are only interested in these bits: 1000 1000
                             // 1000 1000...etc
        if ((v & 0x8080808080808080) ==
            0) { // if NONE of these are set, e.g. all of them are zero, then
                 // everything is ASCII
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            *latin_output++ = char(data[pos]);
            pos++;
          }
          continue;
        }
      }
    }
    // suppose it is not an all ASCII byte sequence
    uint8_t leading_byte = data[pos]; // leading byte
    if (leading_byte < 0b10000000) {
      // converting one ASCII byte !!!
      *latin_output++ = char(leading_byte);
      pos++;
    } else if ((leading_byte & 0b11100000) ==
               0b11000000) { // the first three bits indicate:
      // We have a two-byte UTF-8
      if (pos + 1 >= len) {
        return result(error_code::TOO_SHORT, pos);
      } // minimal bound checking
      if ((data[pos + 1] & 0b11000000) != 0b10000000) {
        return result(error_code::TOO_SHORT, pos);
      } // checks if the next byte is a valid continuation byte in UTF-8. A
        // valid continuation byte starts with 10.
      // range check -
      uint32_t code_point =
          (leading_byte & 0b00011111) << 6 |
          (data[pos + 1] &
           0b00111111); // assembles the Unicode code point from the two bytes.
                        // It does this by discarding the leading 110 and 10
                        // bits from the two bytes, shifting the remaining bits
                        // of the first byte, and then combining the results
                        // with a bitwise OR operation.
      if (code_point < 0x80) {
        return result(error_code::OVERLONG, pos);
      }
      if (0xFF < code_point) {
        return result(error_code::TOO_LARGE, pos);
      } // We only care about the range 129-255 which is Non-ASCII latin1
        // characters
      *latin_output++ = char(code_point);
      pos += 2;
    } else if ((leading_byte & 0b11110000) == 0b11100000) {
      // We have a three-byte UTF-8
      return result(error_code::TOO_LARGE, pos);
    } else if ((leading_byte & 0b11111000) == 0b11110000) { // 0b11110000
      // we have a 4-byte UTF-8 word.
      return result(error_code::TOO_LARGE, pos);
    } else {
      // we either have too many continuation bytes or an invalid leading byte
      if ((leading_byte & 0b11000000) == 0b10000000) {
        return result(error_code::TOO_LONG, pos);
      }

      return result(error_code::HEADER_BITS, pos);
    }
  }
  return result(error_code::SUCCESS, latin_output - start);
}

inline result rewind_and_convert_with_errors(size_t prior_bytes,
                                             const char *buf, size_t len,
                                             char *latin1_output) {
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
  result res = convert_with_errors(buf, len + extra_len, latin1_output);
  if (res.error) {
    res.count -= extra_len;
  }
  return res;
}

} // namespace utf8_to_latin1
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
