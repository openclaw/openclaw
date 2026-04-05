// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_MEMBER_H_
#define INCLUDE_CPPGC_MEMBER_H_

#include <atomic>
#include <cstddef>
#include <type_traits>

#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/member-storage.h"
#include "cppgc/internal/pointer-policies.h"
#include "cppgc/sentinel-pointer.h"
#include "cppgc/type-traits.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

namespace subtle {
class HeapConsistency;
}  // namespace subtle

class Visitor;

namespace internal {

// MemberBase always refers to the object as const object and defers to
// BasicMember on casting to the right type as needed.
template <typename StorageType>
class V8_TRIVIAL_ABI MemberBase {
 public:
  using RawStorage = StorageType;

 protected:
  struct AtomicInitializerTag {};

  V8_INLINE MemberBase() = default;
  V8_INLINE explicit MemberBase(const void* value) : raw_(value) {}
  V8_INLINE MemberBase(const void* value, AtomicInitializerTag) {
    SetRawAtomic(value);
  }

  V8_INLINE explicit MemberBase(RawStorage raw) : raw_(raw) {}
  V8_INLINE explicit MemberBase(std::nullptr_t) : raw_(nullptr) {}
  V8_INLINE explicit MemberBase(SentinelPointer s) : raw_(s) {}

  V8_INLINE const void** GetRawSlot() const {
    return reinterpret_cast<const void**>(const_cast<MemberBase*>(this));
  }
  V8_INLINE const void* GetRaw() const { return raw_.Load(); }
  V8_INLINE void SetRaw(void* value) { raw_.Store(value); }

  V8_INLINE const void* GetRawAtomic() const { return raw_.LoadAtomic(); }
  V8_INLINE void SetRawAtomic(const void* value) { raw_.StoreAtomic(value); }

  V8_INLINE RawStorage GetRawStorage() const { return raw_; }
  V8_INLINE void SetRawStorageAtomic(RawStorage other) {
    reinterpret_cast<std::atomic<RawStorage>&>(raw_).store(
        other, std::memory_order_relaxed);
  }

  V8_INLINE bool IsCleared() const { return raw_.IsCleared(); }

  V8_INLINE void ClearFromGC() const { raw_.Clear(); }

 private:
  friend class MemberDebugHelper;

  mutable RawStorage raw_;
};

// The basic class from which all Member classes are 'generated'.
template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
class V8_TRIVIAL_ABI BasicMember final : private MemberBase<StorageType>,
                                         private CheckingPolicy {
  using Base = MemberBase<StorageType>;

 public:
  using PointeeType = T;
  using RawStorage = typename Base::RawStorage;

  V8_INLINE constexpr BasicMember() = default;
  V8_INLINE constexpr BasicMember(std::nullptr_t) {}     // NOLINT
  V8_INLINE BasicMember(SentinelPointer s) : Base(s) {}  // NOLINT
  V8_INLINE BasicMember(T* raw) : Base(raw) {            // NOLINT
    InitializingWriteBarrier(raw);
    this->CheckPointer(Get());
  }
  V8_INLINE BasicMember(T& raw)  // NOLINT
      : BasicMember(&raw) {}

  // Atomic ctor. Using the AtomicInitializerTag forces BasicMember to
  // initialize using atomic assignments. This is required for preventing
  // data races with concurrent marking.
  using AtomicInitializerTag = typename Base::AtomicInitializerTag;
  V8_INLINE BasicMember(std::nullptr_t, AtomicInitializerTag atomic)
      : Base(nullptr, atomic) {}
  V8_INLINE BasicMember(SentinelPointer s, AtomicInitializerTag atomic)
      : Base(s, atomic) {}
  V8_INLINE BasicMember(T* raw, AtomicInitializerTag atomic)
      : Base(raw, atomic) {
    InitializingWriteBarrier(raw);
    this->CheckPointer(Get());
  }
  V8_INLINE BasicMember(T& raw, AtomicInitializerTag atomic)
      : BasicMember(&raw, atomic) {}

  // Copy ctor.
  V8_INLINE BasicMember(const BasicMember& other)
      : BasicMember(other.GetRawStorage()) {}

  // Heterogeneous copy constructors. When the source pointer have a different
  // type, perform a compress-decompress round, because the source pointer may
  // need to be adjusted.
  template <typename U, typename OtherBarrierPolicy, typename OtherWeaknessTag,
            typename OtherCheckingPolicy,
            std::enable_if_t<internal::IsDecayedSameV<T, U>>* = nullptr>
  V8_INLINE BasicMember(  // NOLINT
      const BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy,
                        OtherCheckingPolicy, StorageType>& other)
      : BasicMember(other.GetRawStorage()) {}

  template <typename U, typename OtherBarrierPolicy, typename OtherWeaknessTag,
            typename OtherCheckingPolicy,
            std::enable_if_t<internal::IsStrictlyBaseOfV<T, U>>* = nullptr>
  V8_INLINE BasicMember(  // NOLINT
      const BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy,
                        OtherCheckingPolicy, StorageType>& other)
      : BasicMember(other.Get()) {}

  // Move ctor.
  V8_INLINE BasicMember(BasicMember&& other) noexcept
      : BasicMember(other.GetRawStorage()) {
    other.Clear();
  }

  // Heterogeneous move constructors. When the source pointer have a different
  // type, perform a compress-decompress round, because the source pointer may
  // need to be adjusted.
  template <typename U, typename OtherBarrierPolicy, typename OtherWeaknessTag,
            typename OtherCheckingPolicy,
            std::enable_if_t<internal::IsDecayedSameV<T, U>>* = nullptr>
  V8_INLINE BasicMember(
      BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy, OtherCheckingPolicy,
                  StorageType>&& other) noexcept
      : BasicMember(other.GetRawStorage()) {
    other.Clear();
  }

  template <typename U, typename OtherBarrierPolicy, typename OtherWeaknessTag,
            typename OtherCheckingPolicy,
            std::enable_if_t<internal::IsStrictlyBaseOfV<T, U>>* = nullptr>
  V8_INLINE BasicMember(
      BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy, OtherCheckingPolicy,
                  StorageType>&& other) noexcept
      : BasicMember(other.Get()) {
    other.Clear();
  }

  // Construction from Persistent.
  template <typename U, typename PersistentWeaknessPolicy,
            typename PersistentLocationPolicy,
            typename PersistentCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  V8_INLINE BasicMember(const BasicPersistent<U, PersistentWeaknessPolicy,
                                              PersistentLocationPolicy,
                                              PersistentCheckingPolicy>& p)
      : BasicMember(p.Get()) {}

  // Copy assignment.
  V8_INLINE BasicMember& operator=(const BasicMember& other) {
    return operator=(other.GetRawStorage());
  }

  // Heterogeneous copy assignment. When the source pointer have a different
  // type, perform a compress-decompress round, because the source pointer may
  // need to be adjusted.
  template <typename U, typename OtherWeaknessTag, typename OtherBarrierPolicy,
            typename OtherCheckingPolicy>
  V8_INLINE BasicMember& operator=(
      const BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy,
                        OtherCheckingPolicy, StorageType>& other) {
    if constexpr (internal::IsDecayedSameV<T, U>) {
      return operator=(other.GetRawStorage());
    } else {
      static_assert(internal::IsStrictlyBaseOfV<T, U>);
      return operator=(other.Get());
    }
  }

  // Move assignment.
  V8_INLINE BasicMember& operator=(BasicMember&& other) noexcept {
    operator=(other.GetRawStorage());
    other.Clear();
    return *this;
  }

  // Heterogeneous move assignment. When the source pointer have a different
  // type, perform a compress-decompress round, because the source pointer may
  // need to be adjusted.
  template <typename U, typename OtherWeaknessTag, typename OtherBarrierPolicy,
            typename OtherCheckingPolicy>
  V8_INLINE BasicMember& operator=(
      BasicMember<U, OtherWeaknessTag, OtherBarrierPolicy, OtherCheckingPolicy,
                  StorageType>&& other) noexcept {
    if constexpr (internal::IsDecayedSameV<T, U>) {
      operator=(other.GetRawStorage());
    } else {
      static_assert(internal::IsStrictlyBaseOfV<T, U>);
      operator=(other.Get());
    }
    other.Clear();
    return *this;
  }

  // Assignment from Persistent.
  template <typename U, typename PersistentWeaknessPolicy,
            typename PersistentLocationPolicy,
            typename PersistentCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  V8_INLINE BasicMember& operator=(
      const BasicPersistent<U, PersistentWeaknessPolicy,
                            PersistentLocationPolicy, PersistentCheckingPolicy>&
          other) {
    return operator=(other.Get());
  }

  V8_INLINE BasicMember& operator=(T* other) {
    Base::SetRawAtomic(other);
    AssigningWriteBarrier(other);
    this->CheckPointer(Get());
    return *this;
  }

  V8_INLINE BasicMember& operator=(std::nullptr_t) {
    Clear();
    return *this;
  }
  V8_INLINE BasicMember& operator=(SentinelPointer s) {
    Base::SetRawAtomic(s);
    return *this;
  }

  template <typename OtherWeaknessTag, typename OtherBarrierPolicy,
            typename OtherCheckingPolicy>
  V8_INLINE void Swap(BasicMember<T, OtherWeaknessTag, OtherBarrierPolicy,
                                  OtherCheckingPolicy, StorageType>& other) {
    auto tmp = GetRawStorage();
    *this = other;
    other = tmp;
  }

  V8_INLINE explicit operator bool() const { return !Base::IsCleared(); }
  V8_INLINE operator T*() const { return Get(); }
  V8_INLINE T* operator->() const { return Get(); }
  V8_INLINE T& operator*() const { return *Get(); }

  // CFI cast exemption to allow passing SentinelPointer through T* and support
  // heterogeneous assignments between different Member and Persistent handles
  // based on their actual types.
  V8_INLINE V8_CLANG_NO_SANITIZE("cfi-unrelated-cast") T* Get() const {
    // Executed by the mutator, hence non atomic load.
    //
    // The const_cast below removes the constness from MemberBase storage. The
    // following static_cast re-adds any constness if specified through the
    // user-visible template parameter T.
    return static_cast<T*>(const_cast<void*>(Base::GetRaw()));
  }

  V8_INLINE void Clear() {
    Base::SetRawStorageAtomic(RawStorage{});
  }

  V8_INLINE T* Release() {
    T* result = Get();
    Clear();
    return result;
  }

  V8_INLINE const T** GetSlotForTesting() const {
    return reinterpret_cast<const T**>(Base::GetRawSlot());
  }

  V8_INLINE RawStorage GetRawStorage() const {
    return Base::GetRawStorage();
  }

 private:
  V8_INLINE explicit BasicMember(RawStorage raw) : Base(raw) {
    InitializingWriteBarrier(Get());
    this->CheckPointer(Get());
  }

  V8_INLINE BasicMember& operator=(RawStorage other) {
    Base::SetRawStorageAtomic(other);
    AssigningWriteBarrier();
    this->CheckPointer(Get());
    return *this;
  }

  V8_INLINE const T* GetRawAtomic() const {
    return static_cast<const T*>(Base::GetRawAtomic());
  }

  V8_INLINE void InitializingWriteBarrier(T* value) const {
    WriteBarrierPolicy::InitializingBarrier(Base::GetRawSlot(), value);
  }
  V8_INLINE void AssigningWriteBarrier(T* value) const {
    WriteBarrierPolicy::template AssigningBarrier<
        StorageType::kWriteBarrierSlotType>(Base::GetRawSlot(), value);
  }
  V8_INLINE void AssigningWriteBarrier() const {
    WriteBarrierPolicy::template AssigningBarrier<
        StorageType::kWriteBarrierSlotType>(Base::GetRawSlot(),
                                            Base::GetRawStorage());
  }

  V8_INLINE void ClearFromGC() const { Base::ClearFromGC(); }

  V8_INLINE T* GetFromGC() const { return Get(); }

  friend class cppgc::subtle::HeapConsistency;
  friend class cppgc::Visitor;
  template <typename U>
  friend struct cppgc::TraceTrait;
  template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
            typename CheckingPolicy1, typename StorageType1>
  friend class BasicMember;
};

// Member equality operators.
template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator==(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  if constexpr (internal::IsDecayedSameV<T1, T2>) {
    // Check compressed pointers if types are the same.
    return member1.GetRawStorage() == member2.GetRawStorage();
  } else {
    static_assert(internal::IsStrictlyBaseOfV<T1, T2> ||
                  internal::IsStrictlyBaseOfV<T2, T1>);
    // Otherwise, check decompressed pointers.
    return member1.Get() == member2.Get();
  }
}

template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator!=(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  return !(member1 == member2);
}

// Equality with raw pointers.
template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType, typename U>
V8_INLINE bool operator==(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    U* raw) {
  // Never allow comparison with erased pointers.
  static_assert(!internal::IsDecayedSameV<void, U>);

  if constexpr (internal::IsDecayedSameV<T, U>) {
    // Check compressed pointers if types are the same.
    return member.GetRawStorage() == StorageType(raw);
  } else if constexpr (internal::IsStrictlyBaseOfV<T, U>) {
    // Cast the raw pointer to T, which may adjust the pointer.
    return member.GetRawStorage() == StorageType(static_cast<T*>(raw));
  } else {
    // Otherwise, decompressed the member.
    return member.Get() == raw;
  }
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType, typename U>
V8_INLINE bool operator!=(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    U* raw) {
  return !(member == raw);
}

template <typename T, typename U, typename WeaknessTag,
          typename WriteBarrierPolicy, typename CheckingPolicy,
          typename StorageType>
V8_INLINE bool operator==(
    T* raw, const BasicMember<U, WeaknessTag, WriteBarrierPolicy,
                              CheckingPolicy, StorageType>& member) {
  return member == raw;
}

template <typename T, typename U, typename WeaknessTag,
          typename WriteBarrierPolicy, typename CheckingPolicy,
          typename StorageType>
V8_INLINE bool operator!=(
    T* raw, const BasicMember<U, WeaknessTag, WriteBarrierPolicy,
                              CheckingPolicy, StorageType>& member) {
  return !(raw == member);
}

// Equality with sentinel.
template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator==(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    SentinelPointer) {
  return member.GetRawStorage().IsSentinel();
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator!=(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    SentinelPointer s) {
  return !(member == s);
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator==(
    SentinelPointer s, const BasicMember<T, WeaknessTag, WriteBarrierPolicy,
                                         CheckingPolicy, StorageType>& member) {
  return member == s;
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator!=(
    SentinelPointer s, const BasicMember<T, WeaknessTag, WriteBarrierPolicy,
                                         CheckingPolicy, StorageType>& member) {
  return !(s == member);
}

// Equality with nullptr.
template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator==(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    std::nullptr_t) {
  return !static_cast<bool>(member);
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator!=(
    const BasicMember<T, WeaknessTag, WriteBarrierPolicy, CheckingPolicy,
                      StorageType>& member,
    std::nullptr_t n) {
  return !(member == n);
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator==(
    std::nullptr_t n, const BasicMember<T, WeaknessTag, WriteBarrierPolicy,
                                        CheckingPolicy, StorageType>& member) {
  return member == n;
}

template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
          typename CheckingPolicy, typename StorageType>
V8_INLINE bool operator!=(
    std::nullptr_t n, const BasicMember<T, WeaknessTag, WriteBarrierPolicy,
                                        CheckingPolicy, StorageType>& member) {
  return !(n == member);
}

// Relational operators.
template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator<(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  static_assert(
      internal::IsDecayedSameV<T1, T2>,
      "Comparison works only for same pointer type modulo cv-qualifiers");
  return member1.GetRawStorage() < member2.GetRawStorage();
}

template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator<=(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  static_assert(
      internal::IsDecayedSameV<T1, T2>,
      "Comparison works only for same pointer type modulo cv-qualifiers");
  return member1.GetRawStorage() <= member2.GetRawStorage();
}

template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator>(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  static_assert(
      internal::IsDecayedSameV<T1, T2>,
      "Comparison works only for same pointer type modulo cv-qualifiers");
  return member1.GetRawStorage() > member2.GetRawStorage();
}

template <typename T1, typename WeaknessTag1, typename WriteBarrierPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessTag2,
          typename WriteBarrierPolicy2, typename CheckingPolicy2,
          typename StorageType>
V8_INLINE bool operator>=(
    const BasicMember<T1, WeaknessTag1, WriteBarrierPolicy1, CheckingPolicy1,
                      StorageType>& member1,
    const BasicMember<T2, WeaknessTag2, WriteBarrierPolicy2, CheckingPolicy2,
                      StorageType>& member2) {
  static_assert(
      internal::IsDecayedSameV<T1, T2>,
      "Comparison works only for same pointer type modulo cv-qualifiers");
  return member1.GetRawStorage() >= member2.GetRawStorage();
}

template <typename T, typename WriteBarrierPolicy, typename CheckingPolicy,
          typename StorageType>
struct IsWeak<internal::BasicMember<T, WeakMemberTag, WriteBarrierPolicy,
                                    CheckingPolicy, StorageType>>
    : std::true_type {};

}  // namespace internal

/**
 * Members are used in classes to contain strong pointers to other garbage
 * collected objects. All Member fields of a class must be traced in the class'
 * trace method.
 */
template <typename T>
using Member = internal::BasicMember<
    T, internal::StrongMemberTag, internal::DijkstraWriteBarrierPolicy,
    internal::DefaultMemberCheckingPolicy, internal::DefaultMemberStorage>;

/**
 * WeakMember is similar to Member in that it is used to point to other garbage
 * collected objects. However instead of creating a strong pointer to the
 * object, the WeakMember creates a weak pointer, which does not keep the
 * pointee alive. Hence if all pointers to to a heap allocated object are weak
 * the object will be garbage collected. At the time of GC the weak pointers
 * will automatically be set to null.
 */
template <typename T>
using WeakMember = internal::BasicMember<
    T, internal::WeakMemberTag, internal::DijkstraWriteBarrierPolicy,
    internal::DefaultMemberCheckingPolicy, internal::DefaultMemberStorage>;

/**
 * UntracedMember is a pointer to an on-heap object that is not traced for some
 * reason. Do not use this unless you know what you are doing. Keeping raw
 * pointers to on-heap objects is prohibited unless used from stack. Pointee
 * must be kept alive through other means.
 */
template <typename T>
using UntracedMember = internal::BasicMember<
    T, internal::UntracedMemberTag, internal::NoWriteBarrierPolicy,
    internal::DefaultMemberCheckingPolicy, internal::DefaultMemberStorage>;

namespace subtle {

/**
 * UncompressedMember. Use with care in hot paths that would otherwise cause
 * many decompression cycles.
 */
template <typename T>
using UncompressedMember = internal::BasicMember<
    T, internal::StrongMemberTag, internal::DijkstraWriteBarrierPolicy,
    internal::DefaultMemberCheckingPolicy, internal::RawPointer>;

#if defined(CPPGC_POINTER_COMPRESSION)
/**
 * CompressedMember. Default implementation of cppgc::Member on builds with
 * pointer compression.
 */
template <typename T>
using CompressedMember = internal::BasicMember<
    T, internal::StrongMemberTag, internal::DijkstraWriteBarrierPolicy,
    internal::DefaultMemberCheckingPolicy, internal::CompressedPointer>;
#endif  // defined(CPPGC_POINTER_COMPRESSION)

}  // namespace subtle

namespace internal {

struct Dummy;

static constexpr size_t kSizeOfMember = sizeof(Member<Dummy>);
static constexpr size_t kSizeOfUncompressedMember =
    sizeof(subtle::UncompressedMember<Dummy>);
#if defined(CPPGC_POINTER_COMPRESSION)
static constexpr size_t kSizeofCompressedMember =
    sizeof(subtle::CompressedMember<Dummy>);
#endif  // defined(CPPGC_POINTER_COMPRESSION)

}  // namespace internal

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_MEMBER_H_
