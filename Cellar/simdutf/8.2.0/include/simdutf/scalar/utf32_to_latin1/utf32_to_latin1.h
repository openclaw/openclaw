#ifndef SIMDUTF_UTF32_TO_LATIN1_H
#define SIMDUTF_UTF32_TO_LATIN1_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf32_to_latin1 {

inline simdutf_constexpr23 size_t convert(const char32_t *data, size_t len,
                                          char *latin1_output) {
  char *start = latin1_output;
  uint32_t utf32_char;
  size_t pos = 0;
  uint32_t too_large = 0;

  while (pos < len) {
    utf32_char = (uint32_t)data[pos];
    too_large |= utf32_char;
    *latin1_output++ = (char)(utf32_char & 0xFF);
    pos++;
  }
  if ((too_large & 0xFFFFFF00) != 0) {
    return 0;
  }
  return latin1_output - start;
}

inline simdutf_constexpr23 result convert_with_errors(const char32_t *data,
                                                      size_t len,
                                                      char *latin1_output) {
  char *start{latin1_output};
  size_t pos = 0;
  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    {
      if (pos + 2 <= len) { // if it is safe to read 8 more bytes, check that
                            // they are Latin1
        uint64_t v;
        ::memcpy(&v, data + pos, sizeof(uint64_t));
        if ((v & 0xFFFFFF00FFFFFF00) == 0) {
          *latin1_output++ = char(data[pos]);
          *latin1_output++ = char(data[pos + 1]);
          pos += 2;
          continue;
        }
      }
    }

    uint32_t utf32_char = data[pos];
    if ((utf32_char & 0xFFFFFF00) ==
        0) { // Check if the character can be represented in Latin-1
      *latin1_output++ = (char)(utf32_char & 0xFF);
      pos++;
    } else {
      return result(error_code::TOO_LARGE, pos);
    };
  }
  return result(error_code::SUCCESS, latin1_output - start);
}

} // namespace utf32_to_latin1
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
