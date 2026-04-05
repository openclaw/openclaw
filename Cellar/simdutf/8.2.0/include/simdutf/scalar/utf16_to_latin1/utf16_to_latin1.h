#ifndef SIMDUTF_UTF16_TO_LATIN1_H
#define SIMDUTF_UTF16_TO_LATIN1_H

#include <cstring> // for std::memcpy

namespace simdutf {
namespace scalar {
namespace {
namespace utf16_to_latin1 {

template <endianness big_endian, typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_utf16<InputPtr> &&
           simdutf::detail::index_assignable_from_char<OutputPtr>)
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   OutputPtr latin_output) {
  if (len == 0) {
    return 0;
  }
  size_t pos = 0;
  const auto latin_output_start = latin_output;
  uint16_t word = 0;
  uint16_t too_large = 0;

  while (pos < len) {
    word = !match_system(big_endian) ? u16_swap_bytes(data[pos]) : data[pos];
    too_large |= word;
    *latin_output++ = char(word & 0xFF);
    pos++;
  }
  if ((too_large & 0xFF00) != 0) {
    return 0;
  }

  return latin_output - latin_output_start;
}

template <endianness big_endian, typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_utf16<InputPtr> &&
           simdutf::detail::index_assignable_from_char<OutputPtr>)
#endif
simdutf_constexpr23 result convert_with_errors(InputPtr data, size_t len,
                                               OutputPtr latin_output) {
  if (len == 0) {
    return result(error_code::SUCCESS, 0);
  }
  size_t pos = 0;
  auto start = latin_output;
  uint16_t word;

  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    {
      if (pos + 16 <= len) { // if it is safe to read 32 more bytes, check that
                             // they are Latin1
        uint64_t v1, v2, v3, v4;
        ::memcpy(&v1, data + pos, sizeof(uint64_t));
        ::memcpy(&v2, data + pos + 4, sizeof(uint64_t));
        ::memcpy(&v3, data + pos + 8, sizeof(uint64_t));
        ::memcpy(&v4, data + pos + 12, sizeof(uint64_t));

        if simdutf_constexpr (!match_system(big_endian)) {
          v1 = (v1 >> 8) | (v1 << (64 - 8));
        }
        if simdutf_constexpr (!match_system(big_endian)) {
          v2 = (v2 >> 8) | (v2 << (64 - 8));
        }
        if simdutf_constexpr (!match_system(big_endian)) {
          v3 = (v3 >> 8) | (v3 << (64 - 8));
        }
        if simdutf_constexpr (!match_system(big_endian)) {
          v4 = (v4 >> 8) | (v4 << (64 - 8));
        }

        if (((v1 | v2 | v3 | v4) & 0xFF00FF00FF00FF00) == 0) {
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            *latin_output++ = !match_system(big_endian)
                                  ? char(u16_swap_bytes(data[pos]))
                                  : char(data[pos]);
            pos++;
          }
          continue;
        }
      }
    }

    word = !match_system(big_endian) ? u16_swap_bytes(data[pos]) : data[pos];
    if ((word & 0xFF00) == 0) {
      *latin_output++ = char(word & 0xFF);
      pos++;
    } else {
      return result(error_code::TOO_LARGE, pos);
    }
  }
  return result(error_code::SUCCESS, latin_output - start);
}

} // namespace utf16_to_latin1
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
