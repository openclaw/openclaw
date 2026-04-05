#ifndef SIMDUTF_ATOMIC_UTIL_H
#define SIMDUTF_ATOMIC_UTIL_H
#if SIMDUTF_ATOMIC_REF
  #include <atomic>
namespace simdutf {
namespace scalar {

// This function is a memcpy that uses atomic operations to read from the
// source.
inline void memcpy_atomic_read(char *dst, const char *src, size_t len) {
  static_assert(std::atomic_ref<char>::required_alignment == sizeof(char),
                "std::atomic_ref requires the same alignment as char_type");
  // We expect all 64-bit systems to be able to read 64-bit words from an
  // aligned memory region atomically. You might be able to do better on
  // specific systems, e.g., x64 systems can read 128-bit words atomically.
  constexpr size_t alignment = sizeof(uint64_t);

  // Lambda for atomic byte-by-byte copy
  auto bbb_memcpy_atomic_read = [](char *bytedst, const char *bytesrc,
                                   size_t bytelen) noexcept {
    char *mutable_src = const_cast<char *>(bytesrc);
    for (size_t j = 0; j < bytelen; ++j) {
      bytedst[j] =
          std::atomic_ref<char>(mutable_src[j]).load(std::memory_order_relaxed);
    }
  };

  // Handle unaligned start
  size_t offset = reinterpret_cast<std::uintptr_t>(src) % alignment;
  if (offset) {
    size_t to_align = std::min(len, alignment - offset);
    bbb_memcpy_atomic_read(dst, src, to_align);
    src += to_align;
    dst += to_align;
    len -= to_align;
  }

  // Process aligned 64-bit chunks
  while (len >= alignment) {
    auto *src_aligned = reinterpret_cast<uint64_t *>(const_cast<char *>(src));
    const auto dst_value =
        std::atomic_ref<uint64_t>(*src_aligned).load(std::memory_order_relaxed);
    std::memcpy(dst, &dst_value, sizeof(uint64_t));
    src += alignment;
    dst += alignment;
    len -= alignment;
  }

  // Handle remaining bytes
  if (len) {
    bbb_memcpy_atomic_read(dst, src, len);
  }
}

// This function is a memcpy that uses atomic operations to write to the
// destination.
inline void memcpy_atomic_write(char *dst, const char *src, size_t len) {
  static_assert(std::atomic_ref<char>::required_alignment == sizeof(char),
                "std::atomic_ref requires the same alignment as char");
  // We expect all 64-bit systems to be able to write 64-bit words to an aligned
  // memory region atomically.
  // You might be able to do better on specific systems, e.g., x64 systems can
  // write 128-bit words atomically.
  constexpr size_t alignment = sizeof(uint64_t);

  // Lambda for atomic byte-by-byte write
  auto bbb_memcpy_atomic_write = [](char *bytedst, const char *bytesrc,
                                    size_t bytelen) noexcept {
    for (size_t j = 0; j < bytelen; ++j) {
      std::atomic_ref<char>(bytedst[j])
          .store(bytesrc[j], std::memory_order_relaxed);
    }
  };

  // Handle unaligned start
  size_t offset = reinterpret_cast<std::uintptr_t>(dst) % alignment;
  if (offset) {
    size_t to_align = std::min(len, alignment - offset);
    bbb_memcpy_atomic_write(dst, src, to_align);
    dst += to_align;
    src += to_align;
    len -= to_align;
  }

  // Process aligned 64-bit chunks
  while (len >= alignment) {
    auto *dst_aligned = reinterpret_cast<uint64_t *>(dst);
    uint64_t src_val;
    std::memcpy(&src_val, src, sizeof(uint64_t)); // Non-atomic read from src
    std::atomic_ref<uint64_t>(*dst_aligned)
        .store(src_val, std::memory_order_relaxed);
    dst += alignment;
    src += alignment;
    len -= alignment;
  }

  // Handle remaining bytes
  if (len) {
    bbb_memcpy_atomic_write(dst, src, len);
  }
}
} // namespace scalar
} // namespace simdutf
#endif // SIMDUTF_ATOMIC_REF
#endif // SIMDUTF_ATOMIC_UTIL_H
