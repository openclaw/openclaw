#ifndef SIMDUTF_VALID_UTF32_TO_UTF8_H
#define SIMDUTF_VALID_UTF32_TO_UTF8_H

namespace simdutf {
namespace scalar {
namespace {
namespace utf32_to_utf8 {

template <typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_utf32<InputPtr> &&
           simdutf::detail::index_assignable_from_char<OutputPtr>)
#endif
simdutf_constexpr23 size_t convert_valid(InputPtr data, size_t len,
                                         OutputPtr utf8_output) {
  size_t pos = 0;
  auto start = utf8_output;
  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    { // try to convert the next block of 2 ASCII characters
      if (pos + 2 <= len) { // if it is safe to read 8 more bytes, check that
                            // they are ascii
        uint64_t v;
        ::memcpy(&v, data + pos, sizeof(uint64_t));
        if ((v & 0xFFFFFF80FFFFFF80) == 0) {
          *utf8_output++ = char(data[pos]);
          *utf8_output++ = char(data[pos + 1]);
          pos += 2;
          continue;
        }
      }
    }

    uint32_t word = data[pos];
    if ((word & 0xFFFFFF80) == 0) {
      // will generate one UTF-8 bytes
      *utf8_output++ = char(word);
      pos++;
    } else if ((word & 0xFFFFF800) == 0) {
      // will generate two UTF-8 bytes
      // we have 0b110XXXXX 0b10XXXXXX
      *utf8_output++ = char((word >> 6) | 0b11000000);
      *utf8_output++ = char((word & 0b111111) | 0b10000000);
      pos++;
    } else if ((word & 0xFFFF0000) == 0) {
      // will generate three UTF-8 bytes
      // we have 0b1110XXXX 0b10XXXXXX 0b10XXXXXX
      *utf8_output++ = char((word >> 12) | 0b11100000);
      *utf8_output++ = char(((word >> 6) & 0b111111) | 0b10000000);
      *utf8_output++ = char((word & 0b111111) | 0b10000000);
      pos++;
    } else {
      // will generate four UTF-8 bytes
      // we have 0b11110XXX 0b10XXXXXX 0b10XXXXXX 0b10XXXXXX
      *utf8_output++ = char((word >> 18) | 0b11110000);
      *utf8_output++ = char(((word >> 12) & 0b111111) | 0b10000000);
      *utf8_output++ = char(((word >> 6) & 0b111111) | 0b10000000);
      *utf8_output++ = char((word & 0b111111) | 0b10000000);
      pos++;
    }
  }
  return utf8_output - start;
}

} // namespace utf32_to_utf8
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
