#ifndef SIMDUTF_LATIN1_TO_UTF16_H
#define SIMDUTF_LATIN1_TO_UTF16_H

namespace simdutf {
namespace scalar {
namespace {
namespace latin1_to_utf16 {

template <endianness big_endian, typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   char16_t *utf16_output) {
  size_t pos = 0;
  char16_t *start{utf16_output};

  while (pos < len) {
    uint16_t word =
        uint8_t(data[pos]); // extend Latin-1 char to 16-bit Unicode code point
    *utf16_output++ =
        char16_t(match_system(big_endian) ? word : u16_swap_bytes(word));
    pos++;
  }

  return utf16_output - start;
}

template <endianness big_endian>
inline result convert_with_errors(const char *buf, size_t len,
                                  char16_t *utf16_output) {
  const uint8_t *data = reinterpret_cast<const uint8_t *>(buf);
  size_t pos = 0;
  char16_t *start{utf16_output};

  while (pos < len) {
    uint16_t word =
        uint16_t(data[pos]); // extend Latin-1 char to 16-bit Unicode code point
    *utf16_output++ =
        char16_t(match_system(big_endian) ? word : u16_swap_bytes(word));
    pos++;
  }

  return result(error_code::SUCCESS, utf16_output - start);
}

} // namespace latin1_to_utf16
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
