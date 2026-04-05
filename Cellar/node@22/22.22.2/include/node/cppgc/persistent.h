// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_PERSISTENT_H_
#define INCLUDE_CPPGC_PERSISTENT_H_

#include <type_traits>

#include "cppgc/internal/persistent-node.h"
#include "cppgc/internal/pointer-policies.h"
#include "cppgc/sentinel-pointer.h"
#include "cppgc/source-location.h"
#include "cppgc/type-traits.h"
#include "cppgc/visitor.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

// PersistentBase always refers to the object as const object and defers to
// BasicPersistent on casting to the right type as needed.
class PersistentBase {
 protected:
  PersistentBase() = default;
  explicit PersistentBase(const void* raw) : raw_(raw) {}

  const void* GetValue() const { return raw_; }
  void SetValue(const void* value) { raw_ = value; }

  PersistentNode* GetNode() const { return node_; }
  void SetNode(PersistentNode* node) { node_ = node; }

  // Performs a shallow clear which assumes that internal persistent nodes are
  // destroyed elsewhere.
  void ClearFromGC() const {
    raw_ = nullptr;
    node_ = nullptr;
  }

 protected:
  mutable const void* raw_ = nullptr;
  mutable PersistentNode* node_ = nullptr;

  friend class PersistentRegionBase;
};

// The basic class from which all Persistent classes are generated.
template <typename T, typename WeaknessPolicy, typename LocationPolicy,
          typename CheckingPolicy>
class BasicPersistent final : public PersistentBase,
                              public LocationPolicy,
                              private WeaknessPolicy,
                              private CheckingPolicy {
 public:
  using typename WeaknessPolicy::IsStrongPersistent;
  using PointeeType = T;

  // Null-state/sentinel constructors.
  BasicPersistent(  // NOLINT
      const SourceLocation& loc = SourceLocation::Current())
      : LocationPolicy(loc) {}

  BasicPersistent(std::nullptr_t,  // NOLINT
                  const SourceLocation& loc = SourceLocation::Current())
      : LocationPolicy(loc) {}

  BasicPersistent(  // NOLINT
      SentinelPointer s, const SourceLocation& loc = SourceLocation::Current())
      : PersistentBase(s), LocationPolicy(loc) {}

  // Raw value constructors.
  BasicPersistent(T* raw,  // NOLINT
                  const SourceLocation& loc = SourceLocation::Current())
      : PersistentBase(raw), LocationPolicy(loc) {
    if (!IsValid()) return;
    SetNode(WeaknessPolicy::GetPersistentRegion(GetValue())
                .AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(Get());
  }

  BasicPersistent(T& raw,  // NOLINT
                  const SourceLocation& loc = SourceLocation::Current())
      : BasicPersistent(&raw, loc) {}

  // Copy ctor.
  BasicPersistent(const BasicPersistent& other,
                  const SourceLocation& loc = SourceLocation::Current())
      : BasicPersistent(other.Get(), loc) {}

  // Heterogeneous ctor.
  template <typename U, typename OtherWeaknessPolicy,
            typename OtherLocationPolicy, typename OtherCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  // NOLINTNEXTLINE
  BasicPersistent(
      const BasicPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                            OtherCheckingPolicy>& other,
      const SourceLocation& loc = SourceLocation::Current())
      : BasicPersistent(other.Get(), loc) {}

  // Move ctor. The heterogeneous move ctor is not supported since e.g.
  // persistent can't reuse persistent node from weak persistent.
  BasicPersistent(
      BasicPersistent&& other,
      const SourceLocation& loc = SourceLocation::Current()) noexcept
      : PersistentBase(std::move(other)), LocationPolicy(std::move(other)) {
    if (!IsValid()) return;
    GetNode()->UpdateOwner(this);
    other.SetValue(nullptr);
    other.SetNode(nullptr);
    this->CheckPointer(Get());
  }

  // Constructor from member.
  template <typename U, typename MemberBarrierPolicy,
            typename MemberWeaknessTag, typename MemberCheckingPolicy,
            typename MemberStorageType,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  // NOLINTNEXTLINE
  BasicPersistent(const internal::BasicMember<
                      U, MemberBarrierPolicy, MemberWeaknessTag,
                      MemberCheckingPolicy, MemberStorageType>& member,
                  const SourceLocation& loc = SourceLocation::Current())
      : BasicPersistent(member.Get(), loc) {}

  ~BasicPersistent() { Clear(); }

  // Copy assignment.
  BasicPersistent& operator=(const BasicPersistent& other) {
    return operator=(other.Get());
  }

  template <typename U, typename OtherWeaknessPolicy,
            typename OtherLocationPolicy, typename OtherCheckingPolicy,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicPersistent& operator=(
      const BasicPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                            OtherCheckingPolicy>& other) {
    return operator=(other.Get());
  }

  // Move assignment.
  BasicPersistent& operator=(BasicPersistent&& other) noexcept {
    if (this == &other) return *this;
    Clear();
    PersistentBase::operator=(std::move(other));
    LocationPolicy::operator=(std::move(other));
    if (!IsValid()) return *this;
    GetNode()->UpdateOwner(this);
    other.SetValue(nullptr);
    other.SetNode(nullptr);
    this->CheckPointer(Get());
    return *this;
  }

  // Assignment from member.
  template <typename U, typename MemberBarrierPolicy,
            typename MemberWeaknessTag, typename MemberCheckingPolicy,
            typename MemberStorageType,
            typename = std::enable_if_t<std::is_base_of<T, U>::value>>
  BasicPersistent& operator=(
      const internal::BasicMember<U, MemberBarrierPolicy, MemberWeaknessTag,
                                  MemberCheckingPolicy, MemberStorageType>&
          member) {
    return operator=(member.Get());
  }

  BasicPersistent& operator=(T* other) {
    Assign(other);
    return *this;
  }

  BasicPersistent& operator=(std::nullptr_t) {
    Clear();
    return *this;
  }

  BasicPersistent& operator=(SentinelPointer s) {
    Assign(s);
    return *this;
  }

  explicit operator bool() const { return Get(); }
  // Historically we allow implicit conversions to T*.
  // NOLINTNEXTLINE
  operator T*() const { return Get(); }
  T* operator->() const { return Get(); }
  T& operator*() const { return *Get(); }

  // CFI cast exemption to allow passing SentinelPointer through T* and support
  // heterogeneous assignments between different Member and Persistent handles
  // based on their actual types.
  V8_CLANG_NO_SANITIZE("cfi-unrelated-cast") T* Get() const {
    // The const_cast below removes the constness from PersistentBase storage.
    // The following static_cast re-adds any constness if specified through the
    // user-visible template parameter T.
    return static_cast<T*>(const_cast<void*>(GetValue()));
  }

  void Clear() {
    // Simplified version of `Assign()` to allow calling without a complete type
    // `T`.
    if (IsValid()) {
      WeaknessPolicy::GetPersistentRegion(GetValue()).FreeNode(GetNode());
      SetNode(nullptr);
    }
    SetValue(nullptr);
  }

  T* Release() {
    T* result = Get();
    Clear();
    return result;
  }

  template <typename U, typename OtherWeaknessPolicy = WeaknessPolicy,
            typename OtherLocationPolicy = LocationPolicy,
            typename OtherCheckingPolicy = CheckingPolicy>
  BasicPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                  OtherCheckingPolicy>
  To() const {
    return BasicPersistent<U, OtherWeaknessPolicy, OtherLocationPolicy,
                           OtherCheckingPolicy>(static_cast<U*>(Get()));
  }

 private:
  static void TraceAsRoot(RootVisitor& root_visitor, const void* ptr) {
    root_visitor.Trace(*static_cast<const BasicPersistent*>(ptr));
  }

  bool IsValid() const {
    // Ideally, handling kSentinelPointer would be done by the embedder. On the
    // other hand, having Persistent aware of it is beneficial since no node
    // gets wasted.
    return GetValue() != nullptr && GetValue() != kSentinelPointer;
  }

  void Assign(T* ptr) {
    if (IsValid()) {
      if (ptr && ptr != kSentinelPointer) {
        // Simply assign the pointer reusing the existing node.
        SetValue(ptr);
        this->CheckPointer(ptr);
        return;
      }
      WeaknessPolicy::GetPersistentRegion(GetValue()).FreeNode(GetNode());
      SetNode(nullptr);
    }
    SetValue(ptr);
    if (!IsValid()) return;
    SetNode(WeaknessPolicy::GetPersistentRegion(GetValue())
                .AllocateNode(this, &TraceAsRoot));
    this->CheckPointer(Get());
  }

  void ClearFromGC() const {
    if (IsValid()) {
      WeaknessPolicy::GetPersistentRegion(GetValue()).FreeNode(GetNode());
      PersistentBase::ClearFromGC();
    }
  }

  // Set Get() for details.
  V8_CLANG_NO_SANITIZE("cfi-unrelated-cast")
  T* GetFromGC() const {
    return static_cast<T*>(const_cast<void*>(GetValue()));
  }

  friend class internal::RootVisitor;
};

template <typename T1, typename WeaknessPolicy1, typename LocationPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessPolicy2,
          typename LocationPolicy2, typename CheckingPolicy2>
bool operator==(const BasicPersistent<T1, WeaknessPolicy1, LocationPolicy1,
                                      CheckingPolicy1>& p1,
                const BasicPersistent<T2, WeaknessPolicy2, LocationPolicy2,
                                      CheckingPolicy2>& p2) {
  return p1.Get() == p2.Get();
}

template <typename T1, typename WeaknessPolicy1, typename LocationPolicy1,
          typename CheckingPolicy1, typename T2, typename WeaknessPolicy2,
          typename LocationPolicy2, typename CheckingPolicy2>
bool operator!=(const BasicPersistent<T1, WeaknessPolicy1, LocationPolicy1,
                                      CheckingPolicy1>& p1,
                const BasicPersistent<T2, WeaknessPolicy2, LocationPolicy2,
                                      CheckingPolicy2>& p2) {
  return !(p1 == p2);
}

template <typename T1, typename PersistentWeaknessPolicy,
          typename PersistentLocationPolicy, typename PersistentCheckingPolicy,
          typename T2, typename MemberWriteBarrierPolicy,
          typename MemberWeaknessTag, typename MemberCheckingPolicy,
          typename MemberStorageType>
bool operator==(
    const BasicPersistent<T1, PersistentWeaknessPolicy,
                          PersistentLocationPolicy, PersistentCheckingPolicy>&
        p,
    const BasicMember<T2, MemberWeaknessTag, MemberWriteBarrierPolicy,
                      MemberCheckingPolicy, MemberStorageType>& m) {
  return p.Get() == m.Get();
}

template <typename T1, typename PersistentWeaknessPolicy,
          typename PersistentLocationPolicy, typename PersistentCheckingPolicy,
          typename T2, typename MemberWriteBarrierPolicy,
          typename MemberWeaknessTag, typename MemberCheckingPolicy,
          typename MemberStorageType>
bool operator!=(
    const BasicPersistent<T1, PersistentWeaknessPolicy,
                          PersistentLocationPolicy, PersistentCheckingPolicy>&
        p,
    const BasicMember<T2, MemberWeaknessTag, MemberWriteBarrierPolicy,
                      MemberCheckingPolicy, MemberStorageType>& m) {
  return !(p == m);
}

template <typename T1, typename MemberWriteBarrierPolicy,
          typename MemberWeaknessTag, typename MemberCheckingPolicy,
          typename MemberStorageType, typename T2,
          typename PersistentWeaknessPolicy, typename PersistentLocationPolicy,
          typename PersistentCheckingPolicy>
bool operator==(
    const BasicMember<T2, MemberWeaknessTag, MemberWriteBarrierPolicy,
                      MemberCheckingPolicy, MemberStorageType>& m,
    const BasicPersistent<T1, PersistentWeaknessPolicy,
                          PersistentLocationPolicy, PersistentCheckingPolicy>&
        p) {
  return m.Get() == p.Get();
}

template <typename T1, typename MemberWriteBarrierPolicy,
          typename MemberWeaknessTag, typename MemberCheckingPolicy,
          typename MemberStorageType, typename T2,
          typename PersistentWeaknessPolicy, typename PersistentLocationPolicy,
          typename PersistentCheckingPolicy>
bool operator!=(
    const BasicMember<T2, MemberWeaknessTag, MemberWriteBarrierPolicy,
                      MemberCheckingPolicy, MemberStorageType>& m,
    const BasicPersistent<T1, PersistentWeaknessPolicy,
                          PersistentLocationPolicy, PersistentCheckingPolicy>&
        p) {
  return !(m == p);
}

template <typename T, typename LocationPolicy, typename CheckingPolicy>
struct IsWeak<BasicPersistent<T, internal::WeakPersistentPolicy, LocationPolicy,
                              CheckingPolicy>> : std::true_type {};
}  // namespace internal

/**
 * Persistent is a way to create a strong pointer from an off-heap object to
 * another on-heap object. As long as the Persistent handle is alive the GC will
 * keep the object pointed to alive. The Persistent handle is always a GC root
 * from the point of view of the GC. Persistent must be constructed and
 * destructed in the same thread.
 */
template <typename T>
using Persistent =
    internal::BasicPersistent<T, internal::StrongPersistentPolicy>;

/**
 * WeakPersistent is a way to create a weak pointer from an off-heap object to
 * an on-heap object. The pointer is automatically cleared when the pointee gets
 * collected. WeakPersistent must be constructed and destructed in the same
 * thread.
 */
template <typename T>
using WeakPersistent =
    internal::BasicPersistent<T, internal::WeakPersistentPolicy>;

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_PERSISTENT_H_
