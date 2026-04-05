#ifndef SIMDUTF_ASCII_H
#define SIMDUTF_ASCII_H

namespace simdutf {
namespace scalar {
namespace {
namespace ascii {

template <class InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_warn_unused simdutf_constexpr23 bool validate(InputPtr data,
                                                      size_t len) noexcept {
  uint64_t pos = 0;

#if SIMDUTF_CPLUSPLUS23
  // avoid memcpy during constant evaluation
  if !consteval
#endif
  // process in blocks of 16 bytes when possible
  {
    for (; pos + 16 <= len; pos += 16) {
      uint64_t v1;
      std::memcpy(&v1, data + pos, sizeof(uint64_t));
      uint64_t v2;
      std::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
      uint64_t v{v1 | v2};
      if ((v & 0x8080808080808080) != 0) {
        return false;
      }
    }
  }

  // process the tail byte-by-byte
  for (; pos < len; pos++) {
    if (static_cast<std::uint8_t>(data[pos]) >= 0b10000000) {
      return false;
    }
  }
  return true;
}
template <class InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_warn_unused simdutf_constexpr23 result
validate_with_errors(InputPtr data, size_t len) noexcept {
  size_t pos = 0;
#if SIMDUTF_CPLUSPLUS23
  // avoid memcpy during constant evaluation
  if !consteval
#endif
  {
    // process in blocks of 16 bytes when possible
    for (; pos + 16 <= len; pos += 16) {
      uint64_t v1;
      std::memcpy(&v1, data + pos, sizeof(uint64_t));
      uint64_t v2;
      std::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
      uint64_t v{v1 | v2};
      if ((v & 0x8080808080808080) != 0) {
        for (; pos < len; pos++) {
          if (static_cast<std::uint8_t>(data[pos]) >= 0b10000000) {
            return result(error_code::TOO_LARGE, pos);
          }
        }
      }
    }
  }

  // process the tail byte-by-byte
  for (; pos < len; pos++) {
    if (static_cast<std::uint8_t>(data[pos]) >= 0b10000000) {
      return result(error_code::TOO_LARGE, pos);
    }
  }
  return result(error_code::SUCCESS, pos);
}

} // namespace ascii
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
