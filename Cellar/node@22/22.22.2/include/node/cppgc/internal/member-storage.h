// Copyright 2022 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_MEMBER_STORAGE_H_
#define INCLUDE_CPPGC_INTERNAL_MEMBER_STORAGE_H_

#include <atomic>
#include <cstddef>
#include <type_traits>

#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/logging.h"
#include "cppgc/sentinel-pointer.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

enum class WriteBarrierSlotType {
  kCompressed,
  kUncompressed,
};

#if defined(CPPGC_POINTER_COMPRESSION)

#if defined(__clang__)
// Attribute const allows the compiler to assume that CageBaseGlobal::g_base_
// doesn't change (e.g. across calls) and thereby avoid redundant loads.
#define CPPGC_CONST __attribute__((const))
#define CPPGC_REQUIRE_CONSTANT_INIT \
  __attribute__((require_constant_initialization))
#else  // defined(__clang__)
#define CPPGC_CONST
#define CPPGC_REQUIRE_CONSTANT_INIT
#endif  // defined(__clang__)

class V8_EXPORT CageBaseGlobal final {
 public:
  V8_INLINE CPPGC_CONST static uintptr_t Get() {
    CPPGC_DCHECK(IsBaseConsistent());
    return g_base_.base;
  }

  V8_INLINE CPPGC_CONST static bool IsSet() {
    CPPGC_DCHECK(IsBaseConsistent());
    return (g_base_.base & ~kLowerHalfWordMask) != 0;
  }

 private:
  // We keep the lower halfword as ones to speed up decompression.
  static constexpr uintptr_t kLowerHalfWordMask =
      (api_constants::kCagedHeapReservationAlignment - 1);

  static union alignas(api_constants::kCachelineSize) Base {
    uintptr_t base;
    char cache_line[api_constants::kCachelineSize];
  } g_base_ CPPGC_REQUIRE_CONSTANT_INIT;

  CageBaseGlobal() = delete;

  V8_INLINE static bool IsBaseConsistent() {
    return kLowerHalfWordMask == (g_base_.base & kLowerHalfWordMask);
  }

  friend class CageBaseGlobalUpdater;
};

#undef CPPGC_REQUIRE_CONSTANT_INIT
#undef CPPGC_CONST

class V8_TRIVIAL_ABI CompressedPointer final {
 public:
  using IntegralType = uint32_t;
  static constexpr auto kWriteBarrierSlotType =
      WriteBarrierSlotType::kCompressed;

  V8_INLINE CompressedPointer() : value_(0u) {}
  V8_INLINE explicit CompressedPointer(const void* ptr)
      : value_(Compress(ptr)) {}
  V8_INLINE explicit CompressedPointer(std::nullptr_t) : value_(0u) {}
  V8_INLINE explicit CompressedPointer(SentinelPointer)
      : value_(kCompressedSentinel) {}

  V8_INLINE const void* Load() const { return Decompress(value_); }
  V8_INLINE const void* LoadAtomic() const {
    return Decompress(
        reinterpret_cast<const std::atomic<IntegralType>&>(value_).load(
            std::memory_order_relaxed));
  }

  V8_INLINE void Store(const void* ptr) { value_ = Compress(ptr); }
  V8_INLINE void StoreAtomic(const void* value) {
    reinterpret_cast<std::atomic<IntegralType>&>(value_).store(
        Compress(value), std::memory_order_relaxed);
  }

  V8_INLINE void Clear() { value_ = 0u; }
  V8_INLINE bool IsCleared() const { return !value_; }

  V8_INLINE bool IsSentinel() const { return value_ == kCompressedSentinel; }

  V8_INLINE uint32_t GetAsInteger() const { return value_; }

  V8_INLINE friend bool operator==(CompressedPointer a, CompressedPointer b) {
    return a.value_ == b.value_;
  }
  V8_INLINE friend bool operator!=(CompressedPointer a, CompressedPointer b) {
    return a.value_ != b.value_;
  }
  V8_INLINE friend bool operator<(CompressedPointer a, CompressedPointer b) {
    return a.value_ < b.value_;
  }
  V8_INLINE friend bool operator<=(CompressedPointer a, CompressedPointer b) {
    return a.value_ <= b.value_;
  }
  V8_INLINE friend bool operator>(CompressedPointer a, CompressedPointer b) {
    return a.value_ > b.value_;
  }
  V8_INLINE friend bool operator>=(CompressedPointer a, CompressedPointer b) {
    return a.value_ >= b.value_;
  }

  static V8_INLINE IntegralType Compress(const void* ptr) {
    static_assert(SentinelPointer::kSentinelValue ==
                      1 << api_constants::kPointerCompressionShift,
                  "The compression scheme relies on the sentinel encoded as 1 "
                  "<< kPointerCompressionShift");
    static constexpr size_t kGigaCageMask =
        ~(api_constants::kCagedHeapReservationAlignment - 1);
    static constexpr size_t kPointerCompressionShiftMask =
        (1 << api_constants::kPointerCompressionShift) - 1;

    CPPGC_DCHECK(CageBaseGlobal::IsSet());
    const uintptr_t base = CageBaseGlobal::Get();
    CPPGC_DCHECK(!ptr || ptr == kSentinelPointer ||
                 (base & kGigaCageMask) ==
                     (reinterpret_cast<uintptr_t>(ptr) & kGigaCageMask));
    CPPGC_DCHECK(
        (reinterpret_cast<uintptr_t>(ptr) & kPointerCompressionShiftMask) == 0);

#if defined(CPPGC_2GB_CAGE)
    // Truncate the pointer.
    auto compressed =
        static_cast<IntegralType>(reinterpret_cast<uintptr_t>(ptr));
#else   // !defined(CPPGC_2GB_CAGE)
    const auto uptr = reinterpret_cast<uintptr_t>(ptr);
    // Shift the pointer and truncate.
    auto compressed = static_cast<IntegralType>(
        uptr >> api_constants::kPointerCompressionShift);
#endif  // !defined(CPPGC_2GB_CAGE)
    // Normal compressed pointers must have the MSB set.
    CPPGC_DCHECK((!compressed || compressed == kCompressedSentinel) ||
                 (compressed & (1 << 31)));
    return compressed;
  }

  static V8_INLINE void* Decompress(IntegralType ptr) {
    CPPGC_DCHECK(CageBaseGlobal::IsSet());
    const uintptr_t base = CageBaseGlobal::Get();
    // Treat compressed pointer as signed and cast it to uint64_t, which will
    // sign-extend it.
#if defined(CPPGC_2GB_CAGE)
    const uint64_t mask = static_cast<uint64_t>(static_cast<int32_t>(ptr));
#else   // !defined(CPPGC_2GB_CAGE)
    // Then, shift the result. It's important to shift the unsigned
    // value, as otherwise it would result in undefined behavior.
    const uint64_t mask = static_cast<uint64_t>(static_cast<int32_t>(ptr))
                          << api_constants::kPointerCompressionShift;
#endif  // !defined(CPPGC_2GB_CAGE)
    return reinterpret_cast<void*>(mask & base);
  }

 private:
#if defined(CPPGC_2GB_CAGE)
  static constexpr IntegralType kCompressedSentinel =
      SentinelPointer::kSentinelValue;
#else   // !defined(CPPGC_2GB_CAGE)
  static constexpr IntegralType kCompressedSentinel =
      SentinelPointer::kSentinelValue >>
      api_constants::kPointerCompressionShift;
#endif  // !defined(CPPGC_2GB_CAGE)
  // All constructors initialize `value_`. Do not add a default value here as it
  // results in a non-atomic write on some builds, even when the atomic version
  // of the constructor is used.
  IntegralType value_;
};

#endif  // defined(CPPGC_POINTER_COMPRESSION)

class V8_TRIVIAL_ABI RawPointer final {
 public:
  using IntegralType = uintptr_t;
  static constexpr auto kWriteBarrierSlotType =
      WriteBarrierSlotType::kUncompressed;

  V8_INLINE RawPointer() : ptr_(nullptr) {}
  V8_INLINE explicit RawPointer(const void* ptr) : ptr_(ptr) {}

  V8_INLINE const void* Load() const { return ptr_; }
  V8_INLINE const void* LoadAtomic() const {
    return reinterpret_cast<const std::atomic<const void*>&>(ptr_).load(
        std::memory_order_relaxed);
  }

  V8_INLINE void Store(const void* ptr) { ptr_ = ptr; }
  V8_INLINE void StoreAtomic(const void* ptr) {
    reinterpret_cast<std::atomic<const void*>&>(ptr_).store(
        ptr, std::memory_order_relaxed);
  }

  V8_INLINE void Clear() { ptr_ = nullptr; }
  V8_INLINE bool IsCleared() const { return !ptr_; }

  V8_INLINE bool IsSentinel() const { return ptr_ == kSentinelPointer; }

  V8_INLINE uintptr_t GetAsInteger() const {
    return reinterpret_cast<uintptr_t>(ptr_);
  }

  V8_INLINE friend bool operator==(RawPointer a, RawPointer b) {
    return a.ptr_ == b.ptr_;
  }
  V8_INLINE friend bool operator!=(RawPointer a, RawPointer b) {
    return a.ptr_ != b.ptr_;
  }
  V8_INLINE friend bool operator<(RawPointer a, RawPointer b) {
    return a.ptr_ < b.ptr_;
  }
  V8_INLINE friend bool operator<=(RawPointer a, RawPointer b) {
    return a.ptr_ <= b.ptr_;
  }
  V8_INLINE friend bool operator>(RawPointer a, RawPointer b) {
    return a.ptr_ > b.ptr_;
  }
  V8_INLINE friend bool operator>=(RawPointer a, RawPointer b) {
    return a.ptr_ >= b.ptr_;
  }

 private:
  // All constructors initialize `ptr_`. Do not add a default value here as it
  // results in a non-atomic write on some builds, even when the atomic version
  // of the constructor is used.
  const void* ptr_;
};

#if defined(CPPGC_POINTER_COMPRESSION)
using DefaultMemberStorage = CompressedPointer;
#else   // !defined(CPPGC_POINTER_COMPRESSION)
using DefaultMemberStorage = RawPointer;
#endif  // !defined(CPPGC_POINTER_COMPRESSION)

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_MEMBER_STORAGE_H_
