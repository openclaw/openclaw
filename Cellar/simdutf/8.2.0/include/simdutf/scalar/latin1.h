#ifndef SIMDUTF_LATIN1_H
#define SIMDUTF_LATIN1_H

namespace simdutf {
namespace scalar {
namespace {
namespace latin1 {

simdutf_really_inline size_t utf8_length_from_latin1(const char *buf,
                                                     size_t len) {
  const uint8_t *c = reinterpret_cast<const uint8_t *>(buf);
  size_t answer = 0;
  for (size_t i = 0; i < len; i++) {
    if ((c[i] >> 7)) {
      answer++;
    }
  }
  return answer + len;
}

} // namespace latin1
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
