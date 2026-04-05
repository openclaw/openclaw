// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_CROSS_THREAD_PERSISTENT_H_
#define INCLUDE_CPPGC_CROSS_THREAD_PERSISTENT_H_

#include <atomic>

#include "cppgc/internal/persistent-node.h"
#include "cppgc/internal/pointer-policies.h"
#include "cppgc/persistent.h"
#include "cppgc/visitor.h"

namespace cppgc {
namespace internal {

// Wrapper around PersistentBase that allows accessing poisoned memory when
// using ASAN. This is needed as the GC of the heap that owns the value
// of a CTP, may clear it (heap termination, weakness) while the object
// holding the CTP may be poisoned as itself may be deemed dead.
class CrossThreadPersistentBase : public PersistentBase {
 public:
  CrossThreadPersistentBase() = default;
  explicit CrossThreadPersistentBase(const void* raw) : PersistentBase(raw) {}

  V8_CLANG_NO_SANITIZE("address") const void* GetValueFromGC() const {
    return raw_;
  }

  V8_CLANG_NO_SANITIZE("address")
  PersistentNode* GetNodeFromGC() const { return node_; }

  V8_CLANG_NO_SANITIZE("address")
  void ClearFromGC() const {
    raw_ = nullptr;
    SetNodeSafe(nullptr);
  }

  // GetNodeSafe() can be used for a thread-safe IsValid() check in a
  // double-checked locking pattern. See ~BasicCrossThreadPersistent.
  PersistentNode* GetNodeSafe() const {
    return reinterpret_cast<std::atomic<PersistentNode*>*>(&node_)->load(
        std::memory_order_acquire);
  }

  // The GC writes using SetNodeSafe() while holding the lock.
  V8_CLANG_NO_SANITIZE("address")
  void SetNodeSafe(PersistentNode* value) const {
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define V8_IS_ASAN 1
#endif
#endif

#ifdef V8_IS_ASAN
    __atomic_store(&node_, &value, __ATOMIC_RELEASE);
#else   // !V8_IS_ASAN
    // Non-ASAN builds can use atomics. This also covers MSVC which does not
    // have the __atomic_store intrinsic.
    reinterpret_cast<std::atomic<PersistentNode*>*>(&node_)->store(
        value, std::memory_order_release);
#endif  // !V8_IS_ASAN

#undef V8_IS_ASAN
  }
};

template <typename T, typename WeaknessPolicy, typename LocationPolicy,
          typename CheckingPolicy>
class BasicCrossThreadPersistent final : public CrossThreadPersistentBase,
                                         public LocationPolicy,
                                         private WeaknessPolicy,
                                         private CheckingPolicy {
 public:
  using typename WeaknessPolicy::IsStrongPersistent;
  using PointeeType = T;

  ~BasicCrossThreadPersistent() {
    //  This implements fast path for destroying empty/sentinel.
    //
    // Simplified version of `AssignUnsafe()` to allow calling without a
    // complete type `T`. Uses double-checked locking with a simple thread-safe
    // check for a valid handle based on a node.
    if (GetNodeSafe()) {
      PersistentRegionLock guard;
      const void* old_value = GetValue();
      // The fast path check (GetNodeSafe()) does not acquire the lock. Recheck
      // validity while holding the lock to ensure the reference has not been
      // cleared.
      if (IsValid(old_value)) {
        CrossThreadPersistentRegion& region =
            this->GetPersistentRegion(old_value);
        region.FreeNode(GetNode());
        SetNode(nullptr);
      } else {
        CPPGC_DCHECK(!GetNode());
      }
    }
    // No need to call SetValue() as the handle is not used anymore. This can
    // leave behind stale sentinel values but will always destroy the underlying
    // node.
  }

  BasicCrossThreadPersistent(
      const SourceLocation& loc = SourceLocation::Current())
      : LocationPolicy(loc) {}

  BasicCrossThreadPersistent(
      std::nullptr_t, const SourceLocation& loc = SourceLocation::Current())
      : LocationPolicy(loc) {}

  BasicCrossThreadPersistent(
      SentinelPointer s, const SourceLocation& loc = SourceLocation::Current())
      : CrossThreadPersistentBase(s), LocationPolicy(loc) {}

  BasicCrossThreadPersistent(
      T* raw, const SourceLocation& loc = SourceLocation::Current())
      : CrossThreadPersistentBase(raw), LocationPolicy(loc) {
    if (!IsValid(raw)) return;
    PersistentRegionLock guard;
    CrossThreadPersistentRegion& region = this->GetPersistentRegion(raw);
    SetNode(region.AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(raw);
  }

  class UnsafeCtorTag {
   private:
    UnsafeCtorTag() = default;
    template <typename U, typename OtherWeaknessPolicy,
              typename OtherLocationPolicy, typename OtherCheckingPolicy>
    friend class BasicCrossThreadPersistent;
  };

  BasicCrossThreadPersistent(
      UnsafeCtorTag, T* raw,
      const SourceLocation& loc = SourceLocation::Current())
      : CrossThreadPersistentBase(raw), LocationPolicy(loc) {
    if (!IsValid(raw)) return;
    CrossThreadPersistentRegion& region = this->GetPersistentRegion(raw);
    SetNode(region.AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(raw);
  }

  BasicCrossThreadPersistent(
      T& raw, const SourceLocation& loc = SourceLocation::Current())
      : BasicCrossThreadPersistent(&raw, loc) {}

  template <typename U, typename MemberBarrierPolicy,
            typename MemberWeaknessTag, typename MemberCheckingPolicy,
            typename MemberStorageType,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicCrossThreadPersistent(
      internal::BasicMember<U, MemberBarrierPolicy, MemberWeaknessTag,
                            MemberCheckingPolicy, MemberStorageType>
          member,
      const SourceLocation& loc = SourceLocation::Current())
      : BasicCrossThreadPersistent(member.Get(), loc) {}

  BasicCrossThreadPersistent(
      const BasicCrossThreadPersistent& other,
      const SourceLocation& loc = SourceLocation::Current())
      : BasicCrossThreadPersistent(loc) {
    // Invoke operator=.
    *this = other;
  }

  // Heterogeneous ctor.
  template <typename U, typename OtherWeaknessPolicy,
            typename OtherLocationPolicy, typename OtherCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicCrossThreadPersistent(
      const BasicCrossThreadPersistent<U, OtherWeaknessPolicy,
                                       OtherLocationPolicy,
                                       OtherCheckingPolicy>& other,
      const SourceLocation& loc = SourceLocation::Current())
      : BasicCrossThreadPersistent(loc) {
    *this = other;
  }

  BasicCrossThreadPersistent(
      BasicCrossThreadPersistent&& other,
      const SourceLocation& loc = SourceLocation::Current()) noexcept {
    // Invoke operator=.
    *this = std::move(other);
  }

  BasicCrossThreadPersistent& operator=(
      const BasicCrossThreadPersistent& other) {
    PersistentRegionLock guard;
    AssignSafe(guard, other.Get());
    return *this;
  }

  template <typename U, typename OtherWeaknessPolicy,
            typename OtherLocationPolicy, typename OtherCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicCrossThreadPersistent& operator=(
      const BasicCrossThreadPersistent<U, OtherWeaknessPolicy,
                                       OtherLocationPolicy,
                                       OtherCheckingPolicy>& other) {
    PersistentRegionLock guard;
    AssignSafe(guard, other.Get());
    return *this;
  }

  BasicCrossThreadPersistent& operator=(BasicCrossThreadPersistent&& other) {
    if (this == &other) return *this;
    Clear();
    PersistentRegionLock guard;
    PersistentBase::operator=(std::move(other));
    LocationPolicy::operator=(std::move(other));
    if (!IsValid(GetValue())) return *this;
    GetNode()->UpdateOwner(this);
    other.SetValue(nullptr);
    other.SetNode(nullptr);
    this->CheckPointer(Get());
    return *this;
  }

  /**
   * Assigns a raw pointer.
   *
   * Note: **Not thread-safe.**
   */
  BasicCrossThreadPersistent& operator=(T* other) {
    AssignUnsafe(other);
    return *this;
  }

  // Assignment from member.
  template <typename U, typename MemberBarrierPolicy,
            typename MemberWeaknessTag, typename MemberCheckingPolicy,
            typename MemberStorageType,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicCrossThreadPersistent& operator=(
      internal::BasicMember<U, MemberBarrierPolicy, MemberWeaknessTag,
                            MemberCheckingPolicy, MemberStorageType>
          member) {
    return operator=(member.Get());
  }

  /**
   * Assigns a nullptr.
   *
   * \returns the handle.
   */
  BasicCrossThreadPersistent& operator=(std::nullptr_t) {
    Clear();
    return *this;
  }

  /**
   * Assigns the sentinel pointer.
   *
   * \returns the handle.
   */
  BasicCrossThreadPersistent& operator=(SentinelPointer s) {
    PersistentRegionLock guard;
    AssignSafe(guard, s);
    return *this;
  }

  /**
   * Returns a pointer to the stored object.
   *
   * Note: **Not thread-safe.**
   *
   * \returns a pointer to the stored object.
   */
  // CFI cast exemption to allow passing SentinelPointer through T* and support
  // heterogeneous assignments between different Member and Persistent handles
  // based on their actual types.
  V8_CLANG_NO_SANITIZE("cfi-unrelated-cast") T* Get() const {
    return static_cast<T*>(const_cast<void*>(GetValue()));
  }

  /**
   * Clears the stored object.
   */
  void Clear() {
    PersistentRegionLock guard;
    AssignSafe(guard, nullptr);
  }

  /**
   * Returns a pointer to the stored object and releases it.
   *
   * Note: **Not thread-safe.**
   *
   * \returns a pointer to the stored object.
   */
  T* Release() {
    T* result = Get();
    Clear();
    return result;
  }

  /**
   * Conversio to boolean.
   *
   * Note: **Not thread-safe.**
   *
   * \returns true if an actual object has been stored and false otherwise.
   */
  explicit operator bool() const { return Get(); }

  /**
   * Conversion to object of type T.
   *
   * Note: **Not thread-safe.**
   *
   * \returns the object.
   */
  operator T*() const { return Get(); }

  /**
   * Dereferences the stored object.
   *
   * Note: **Not thread-safe.**
   */
  T* operator->() const { return Get(); }
  T& operator*() const { return *Get(); }

  template <typename U, typename OtherWeaknessPolicy = WeaknessPolicy,
            typename OtherLocationPolicy = LocationPolicy,
            typename OtherCheckingPolicy = CheckingPolicy>
  BasicCrossThreadPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                             OtherCheckingPolicy>
  To() const {
    using OtherBasicCrossThreadPersistent =
        BasicCrossThreadPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                                   OtherCheckingPolicy>;
    PersistentRegionLock guard;
    return OtherBasicCrossThreadPersistent(
        typename OtherBasicCrossThreadPersistent::UnsafeCtorTag(),
        static_cast<U*>(Get()));
  }

  template <typename U = T,
            typename = typename std::enable_if<!BasicCrossThreadPersistent<
                U, WeaknessPolicy>::IsStrongPersistent::value>::type>
  BasicCrossThreadPersistent<U, internal::StrongCrossThreadPersistentPolicy>
  Lock() const {
    return BasicCrossThreadPersistent<
        U, internal::StrongCrossThreadPersistentPolicy>(*this);
  }

 private:
  static bool IsValid(const void* ptr) {
    return ptr && ptr != kSentinelPointer;
  }

  static void TraceAsRoot(RootVisitor& root_visitor, const void* ptr) {
    root_visitor.Trace(*static_cast<const BasicCrossThreadPersistent*>(ptr));
  }

  void AssignUnsafe(T* ptr) {
    const void* old_value = GetValue();
    if (IsValid(old_value)) {
      PersistentRegionLock guard;
      old_value = GetValue();
      // The fast path check (IsValid()) does not acquire the lock. Reload
      // the value to ensure the reference has not been cleared.
      if (IsValid(old_value)) {
        CrossThreadPersistentRegion& region =
            this->GetPersistentRegion(old_value);
        if (IsValid(ptr) && (&region == &this->GetPersistentRegion(ptr))) {
          SetValue(ptr);
          this->CheckPointer(ptr);
          return;
        }
        region.FreeNode(GetNode());
        SetNode(nullptr);
      } else {
        CPPGC_DCHECK(!GetNode());
      }
    }
    SetValue(ptr);
    if (!IsValid(ptr)) return;
    PersistentRegionLock guard;
    SetNode(this->GetPersistentRegion(ptr).AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(ptr);
  }

  void AssignSafe(PersistentRegionLock&, T* ptr) {
    PersistentRegionLock::AssertLocked();
    const void* old_value = GetValue();
    if (IsValid(old_value)) {
      CrossThreadPersistentRegion& region =
          this->GetPersistentRegion(old_value);
      if (IsValid(ptr) && (&region == &this->GetPersistentRegion(ptr))) {
        SetValue(ptr);
        this->CheckPointer(ptr);
        return;
      }
      region.FreeNode(GetNode());
      SetNode(nullptr);
    }
    SetValue(ptr);
    if (!IsValid(ptr)) return;
    SetNode(this->GetPersistentRegion(ptr).AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(ptr);
  }

  void ClearFromGC() const {
    if (IsValid(GetValueFromGC())) {
      WeaknessPolicy::GetPersistentRegion(GetValueFromGC())
          .FreeNode(GetNodeFromGC());
      CrossThreadPersistentBase::ClearFromGC();
    }
  }

  // See Get() for details.
  V8_CLANG_NO_SANITIZE("cfi-unrelated-cast")
  T* GetFromGC() const {
    return static_cast<T*>(const_cast<void*>(GetValueFromGC()));
  }

  friend class internal::RootVisitor;
};

template <typename T, typename LocationPolicy, typename CheckingPolicy>
struct IsWeak<
    BasicCrossThreadPersistent<T, internal::WeakCrossThreadPersistentPolicy,
                               LocationPolicy, CheckingPolicy>>
    : std::true_type {};

}  // namespace internal

namespace subtle {

/**
 * **DO NOT USE: Has known caveats, see below.**
 *
 * CrossThreadPersistent allows retaining objects from threads other than the
 * thread the owning heap is operating on.
 *
 * Known caveats:
 * - Does not protect the heap owning an object from terminating.
 * - Reaching transitively through the graph is unsupported as objects may be
 *   moved concurrently on the thread owning the object.
 */
template <typename T>
using CrossThreadPersistent = internal::BasicCrossThreadPersistent<
    T, internal::StrongCrossThreadPersistentPolicy>;

/**
 * **DO NOT USE: Has known caveats, see below.**
 *
 * CrossThreadPersistent allows weakly retaining objects from threads other than
 * the thread the owning heap is operating on.
 *
 * Known caveats:
 * - Does not protect the heap owning an object from terminating.
 * - Reaching transitively through the graph is unsupported as objects may be
 *   moved concurrently on the thread owning the object.
 */
template <typename T>
using WeakCrossThreadPersistent = internal::BasicCrossThreadPersistent<
    T, internal::WeakCrossThreadPersistentPolicy>;

}  // namespace subtle
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_CROSS_THREAD_PERSISTENT_H_
