#ifndef SIMDUTF_LATIN1_TO_UTF32_H
#define SIMDUTF_LATIN1_TO_UTF32_H

namespace simdutf {
namespace scalar {
namespace {
namespace latin1_to_utf32 {

template <typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   char32_t *utf32_output) {
  char32_t *start{utf32_output};
  for (size_t i = 0; i < len; i++) {
    *utf32_output++ = uint8_t(data[i]);
  }
  return utf32_output - start;
}

} // namespace latin1_to_utf32
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
