// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_VISITOR_H_
#define INCLUDE_CPPGC_VISITOR_H_

#include <type_traits>

#include "cppgc/custom-space.h"
#include "cppgc/ephemeron-pair.h"
#include "cppgc/garbage-collected.h"
#include "cppgc/internal/logging.h"
#include "cppgc/internal/member-storage.h"
#include "cppgc/internal/pointer-policies.h"
#include "cppgc/liveness-broker.h"
#include "cppgc/member.h"
#include "cppgc/sentinel-pointer.h"
#include "cppgc/source-location.h"
#include "cppgc/trace-trait.h"
#include "cppgc/type-traits.h"

namespace cppgc {

namespace internal {
template <typename T, typename WeaknessPolicy, typename LocationPolicy,
          typename CheckingPolicy>
class BasicCrossThreadPersistent;
template <typename T, typename WeaknessPolicy, typename LocationPolicy,
          typename CheckingPolicy>
class BasicPersistent;
class ConservativeTracingVisitor;
class VisitorBase;
class VisitorFactory;
}  // namespace internal

using WeakCallback = void (*)(const LivenessBroker&, const void*);

/**
 * Visitor passed to trace methods. All managed pointers must have called the
 * Visitor's trace method on them.
 *
 * \code
 * class Foo final : public GarbageCollected<Foo> {
 *  public:
 *   void Trace(Visitor* visitor) const {
 *     visitor->Trace(foo_);
 *     visitor->Trace(weak_foo_);
 *   }
 *  private:
 *   Member<Foo> foo_;
 *   WeakMember<Foo> weak_foo_;
 * };
 * \endcode
 */
class V8_EXPORT Visitor {
 public:
  class Key {
   private:
    Key() = default;
    friend class internal::VisitorFactory;
  };

  explicit Visitor(Key) {}

  virtual ~Visitor() = default;

  /**
   * Trace method for Member.
   *
   * \param member Member reference retaining an object.
   */
  template <typename T>
  void Trace(const Member<T>& member) {
    const T* value = member.GetRawAtomic();
    CPPGC_DCHECK(value != kSentinelPointer);
    TraceImpl(value);
  }

  /**
   * Trace method for WeakMember.
   *
   * \param weak_member WeakMember reference weakly retaining an object.
   */
  template <typename T>
  void Trace(const WeakMember<T>& weak_member) {
    static_assert(sizeof(T), "Pointee type must be fully defined.");
    static_assert(internal::IsGarbageCollectedOrMixinType<T>::value,
                  "T must be GarbageCollected or GarbageCollectedMixin type");
    static_assert(!internal::IsAllocatedOnCompactableSpace<T>::value,
                  "Weak references to compactable objects are not allowed");

    const T* value = weak_member.GetRawAtomic();

    // Bailout assumes that WeakMember emits write barrier.
    if (!value) {
      return;
    }

    CPPGC_DCHECK(value != kSentinelPointer);
    VisitWeak(value, TraceTrait<T>::GetTraceDescriptor(value),
              &HandleWeak<WeakMember<T>>, &weak_member);
  }

#if defined(CPPGC_POINTER_COMPRESSION)
  /**
   * Trace method for UncompressedMember.
   *
   * \param member UncompressedMember reference retaining an object.
   */
  template <typename T>
  void Trace(const subtle::UncompressedMember<T>& member) {
    const T* value = member.GetRawAtomic();
    CPPGC_DCHECK(value != kSentinelPointer);
    TraceImpl(value);
  }
#endif  // defined(CPPGC_POINTER_COMPRESSION)

  template <typename T>
  void TraceMultiple(const subtle::UncompressedMember<T>* start, size_t len) {
    static_assert(sizeof(T), "Pointee type must be fully defined.");
    static_assert(internal::IsGarbageCollectedOrMixinType<T>::value,
                  "T must be GarbageCollected or GarbageCollectedMixin type");
    VisitMultipleUncompressedMember(start, len,
                                    &TraceTrait<T>::GetTraceDescriptor);
  }

  template <typename T,
            std::enable_if_t<!std::is_same_v<
                Member<T>, subtle::UncompressedMember<T>>>* = nullptr>
  void TraceMultiple(const Member<T>* start, size_t len) {
    static_assert(sizeof(T), "Pointee type must be fully defined.");
    static_assert(internal::IsGarbageCollectedOrMixinType<T>::value,
                  "T must be GarbageCollected or GarbageCollectedMixin type");
#if defined(CPPGC_POINTER_COMPRESSION)
    static_assert(std::is_same_v<Member<T>, subtle::CompressedMember<T>>,
                  "Member and CompressedMember must be the same.");
    VisitMultipleCompressedMember(start, len,
                                  &TraceTrait<T>::GetTraceDescriptor);
#endif  // defined(CPPGC_POINTER_COMPRESSION)
  }

  /**
   * Trace method for inlined objects that are not allocated themselves but
   * otherwise follow managed heap layout and have a Trace() method.
   *
   * \param object reference of the inlined object.
   */
  template <typename T>
  void Trace(const T& object) {
#if V8_ENABLE_CHECKS
    // This object is embedded in potentially multiple nested objects. The
    // outermost object must not be in construction as such objects are (a) not
    // processed immediately, and (b) only processed conservatively if not
    // otherwise possible.
    CheckObjectNotInConstruction(&object);
#endif  // V8_ENABLE_CHECKS
    TraceTrait<T>::Trace(this, &object);
  }

  template <typename T>
  void TraceMultiple(const T* start, size_t len) {
#if V8_ENABLE_CHECKS
    // This object is embedded in potentially multiple nested objects. The
    // outermost object must not be in construction as such objects are (a) not
    // processed immediately, and (b) only processed conservatively if not
    // otherwise possible.
    CheckObjectNotInConstruction(start);
#endif  // V8_ENABLE_CHECKS
    for (size_t i = 0; i < len; ++i) {
      const T* object = &start[i];
      if constexpr (std::is_polymorphic_v<T>) {
        // The object's vtable may be uninitialized in which case the object is
        // not traced.
        if (*reinterpret_cast<const uintptr_t*>(object) == 0) continue;
      }
      TraceTrait<T>::Trace(this, object);
    }
  }

  /**
   * Registers a weak callback method on the object of type T. See
   * LivenessBroker for an usage example.
   *
   * \param object of type T specifying a weak callback method.
   */
  template <typename T, void (T::*method)(const LivenessBroker&)>
  void RegisterWeakCallbackMethod(const T* object) {
    RegisterWeakCallback(&WeakCallbackMethodDelegate<T, method>, object);
  }

  /**
   * Trace method for EphemeronPair.
   *
   * \param ephemeron_pair EphemeronPair reference weakly retaining a key object
   * and strongly retaining a value object in case the key object is alive.
   */
  template <typename K, typename V>
  void Trace(const EphemeronPair<K, V>& ephemeron_pair) {
    TraceEphemeron(ephemeron_pair.key, &ephemeron_pair.value);
    RegisterWeakCallbackMethod<EphemeronPair<K, V>,
                               &EphemeronPair<K, V>::ClearValueIfKeyIsDead>(
        &ephemeron_pair);
  }

  /**
   * Trace method for a single ephemeron. Used for tracing a raw ephemeron in
   * which the `key` and `value` are kept separately.
   *
   * \param weak_member_key WeakMember reference weakly retaining a key object.
   * \param member_value Member reference with ephemeron semantics.
   */
  template <typename KeyType, typename ValueType>
  void TraceEphemeron(const WeakMember<KeyType>& weak_member_key,
                      const Member<ValueType>* member_value) {
    const KeyType* key = weak_member_key.GetRawAtomic();
    if (!key) return;

    // `value` must always be non-null.
    CPPGC_DCHECK(member_value);
    const ValueType* value = member_value->GetRawAtomic();
    if (!value) return;

    // KeyType and ValueType may refer to GarbageCollectedMixin.
    TraceDescriptor value_desc =
        TraceTrait<ValueType>::GetTraceDescriptor(value);
    CPPGC_DCHECK(value_desc.base_object_payload);
    const void* key_base_object_payload =
        TraceTrait<KeyType>::GetTraceDescriptor(key).base_object_payload;
    CPPGC_DCHECK(key_base_object_payload);

    VisitEphemeron(key_base_object_payload, value, value_desc);
  }

  /**
   * Trace method for a single ephemeron. Used for tracing a raw ephemeron in
   * which the `key` and `value` are kept separately. Note that this overload
   * is for non-GarbageCollected `value`s that can be traced though.
   *
   * \param key `WeakMember` reference weakly retaining a key object.
   * \param value Reference weakly retaining a value object. Note that
   *   `ValueType` here should not be `Member`. It is expected that
   *   `TraceTrait<ValueType>::GetTraceDescriptor(value)` returns a
   *   `TraceDescriptor` with a null base pointer but a valid trace method.
   */
  template <typename KeyType, typename ValueType>
  void TraceEphemeron(const WeakMember<KeyType>& weak_member_key,
                      const ValueType* value) {
    static_assert(!IsGarbageCollectedOrMixinTypeV<ValueType>,
                  "garbage-collected types must use WeakMember and Member");
    const KeyType* key = weak_member_key.GetRawAtomic();
    if (!key) return;

    // `value` must always be non-null.
    CPPGC_DCHECK(value);
    TraceDescriptor value_desc =
        TraceTrait<ValueType>::GetTraceDescriptor(value);
    // `value_desc.base_object_payload` must be null as this override is only
    // taken for non-garbage-collected values.
    CPPGC_DCHECK(!value_desc.base_object_payload);

    // KeyType might be a GarbageCollectedMixin.
    const void* key_base_object_payload =
        TraceTrait<KeyType>::GetTraceDescriptor(key).base_object_payload;
    CPPGC_DCHECK(key_base_object_payload);

    VisitEphemeron(key_base_object_payload, value, value_desc);
  }

  /**
   * Trace method that strongifies a WeakMember.
   *
   * \param weak_member WeakMember reference retaining an object.
   */
  template <typename T>
  void TraceStrongly(const WeakMember<T>& weak_member) {
    const T* value = weak_member.GetRawAtomic();
    CPPGC_DCHECK(value != kSentinelPointer);
    TraceImpl(value);
  }

  /**
   * Trace method for retaining containers strongly.
   *
   * \param object reference to the container.
   */
  template <typename T>
  void TraceStrongContainer(const T* object) {
    TraceImpl(object);
  }

  /**
   * Trace method for retaining containers weakly. Note that weak containers
   * should emit write barriers.
   *
   * \param object reference to the container.
   * \param callback to be invoked.
   * \param callback_data custom data that is passed to the callback.
   */
  template <typename T>
  void TraceWeakContainer(const T* object, WeakCallback callback,
                          const void* callback_data) {
    if (!object) return;
    VisitWeakContainer(object, TraceTrait<T>::GetTraceDescriptor(object),
                       TraceTrait<T>::GetWeakTraceDescriptor(object), callback,
                       callback_data);
  }

  /**
   * Registers a slot containing a reference to an object allocated on a
   * compactable space. Such references maybe be arbitrarily moved by the GC.
   *
   * \param slot location of reference to object that might be moved by the GC.
   * The slot must contain an uncompressed pointer.
   */
  template <typename T>
  void RegisterMovableReference(const T** slot) {
    static_assert(internal::IsAllocatedOnCompactableSpace<T>::value,
                  "Only references to objects allocated on compactable spaces "
                  "should be registered as movable slots.");
    static_assert(!IsGarbageCollectedMixinTypeV<T>,
                  "Mixin types do not support compaction.");
    HandleMovableReference(reinterpret_cast<const void**>(slot));
  }

  /**
   * Registers a weak callback that is invoked during garbage collection.
   *
   * \param callback to be invoked.
   * \param data custom data that is passed to the callback.
   */
  virtual void RegisterWeakCallback(WeakCallback callback, const void* data) {}

  /**
   * Defers tracing an object from a concurrent thread to the mutator thread.
   * Should be called by Trace methods of types that are not safe to trace
   * concurrently.
   *
   * \param parameter tells the trace callback which object was deferred.
   * \param callback to be invoked for tracing on the mutator thread.
   * \param deferred_size size of deferred object.
   *
   * \returns false if the object does not need to be deferred (i.e. currently
   * traced on the mutator thread) and true otherwise (i.e. currently traced on
   * a concurrent thread).
   */
  virtual V8_WARN_UNUSED_RESULT bool DeferTraceToMutatorThreadIfConcurrent(
      const void* parameter, TraceCallback callback, size_t deferred_size) {
    // By default tracing is not deferred.
    return false;
  }

 protected:
  virtual void Visit(const void* self, TraceDescriptor) {}
  virtual void VisitWeak(const void* self, TraceDescriptor, WeakCallback,
                         const void* weak_member) {}
  virtual void VisitEphemeron(const void* key, const void* value,
                              TraceDescriptor value_desc) {}
  virtual void VisitWeakContainer(const void* self, TraceDescriptor strong_desc,
                                  TraceDescriptor weak_desc,
                                  WeakCallback callback, const void* data) {}
  virtual void HandleMovableReference(const void**) {}

  virtual void VisitMultipleUncompressedMember(
      const void* start, size_t len,
      TraceDescriptorCallback get_trace_descriptor) {
    // Default implementation merely delegates to Visit().
    const char* it = static_cast<const char*>(start);
    const char* end = it + len * internal::kSizeOfUncompressedMember;
    for (; it < end; it += internal::kSizeOfUncompressedMember) {
      const auto* current = reinterpret_cast<const internal::RawPointer*>(it);
      const void* object = current->LoadAtomic();
      if (!object) continue;

      Visit(object, get_trace_descriptor(object));
    }
  }

#if defined(CPPGC_POINTER_COMPRESSION)
  virtual void VisitMultipleCompressedMember(
      const void* start, size_t len,
      TraceDescriptorCallback get_trace_descriptor) {
    // Default implementation merely delegates to Visit().
    const char* it = static_cast<const char*>(start);
    const char* end = it + len * internal::kSizeofCompressedMember;
    for (; it < end; it += internal::kSizeofCompressedMember) {
      const auto* current =
          reinterpret_cast<const internal::CompressedPointer*>(it);
      const void* object = current->LoadAtomic();
      if (!object) continue;

      Visit(object, get_trace_descriptor(object));
    }
  }
#endif  // defined(CPPGC_POINTER_COMPRESSION)

 private:
  template <typename T, void (T::*method)(const LivenessBroker&)>
  static void WeakCallbackMethodDelegate(const LivenessBroker& info,
                                         const void* self) {
    // Callback is registered through a potential const Trace method but needs
    // to be able to modify fields. See HandleWeak.
    (const_cast<T*>(static_cast<const T*>(self))->*method)(info);
  }

  template <typename PointerType>
  static void HandleWeak(const LivenessBroker& info, const void* object) {
    const PointerType* weak = static_cast<const PointerType*>(object);
    if (!info.IsHeapObjectAlive(weak->GetFromGC())) {
      weak->ClearFromGC();
    }
  }

  template <typename T>
  void TraceImpl(const T* t) {
    static_assert(sizeof(T), "Pointee type must be fully defined.");
    static_assert(internal::IsGarbageCollectedOrMixinType<T>::value,
                  "T must be GarbageCollected or GarbageCollectedMixin type");
    if (!t) {
      return;
    }
    Visit(t, TraceTrait<T>::GetTraceDescriptor(t));
  }

#if V8_ENABLE_CHECKS
  void CheckObjectNotInConstruction(const void* address);
#endif  // V8_ENABLE_CHECKS

  template <typename T, typename WeaknessPolicy, typename LocationPolicy,
            typename CheckingPolicy>
  friend class internal::BasicCrossThreadPersistent;
  template <typename T, typename WeaknessPolicy, typename LocationPolicy,
            typename CheckingPolicy>
  friend class internal::BasicPersistent;
  friend class internal::ConservativeTracingVisitor;
  friend class internal::VisitorBase;
};

namespace internal {

class V8_EXPORT RootVisitor {
 public:
  explicit RootVisitor(Visitor::Key) {}

  virtual ~RootVisitor() = default;

  template <typename AnyStrongPersistentType,
            std::enable_if_t<
                AnyStrongPersistentType::IsStrongPersistent::value>* = nullptr>
  void Trace(const AnyStrongPersistentType& p) {
    using PointeeType = typename AnyStrongPersistentType::PointeeType;
    const void* object = Extract(p);
    if (!object) {
      return;
    }
    VisitRoot(object, TraceTrait<PointeeType>::GetTraceDescriptor(object),
              p.Location());
  }

  template <typename AnyWeakPersistentType,
            std::enable_if_t<
                !AnyWeakPersistentType::IsStrongPersistent::value>* = nullptr>
  void Trace(const AnyWeakPersistentType& p) {
    using PointeeType = typename AnyWeakPersistentType::PointeeType;
    static_assert(!internal::IsAllocatedOnCompactableSpace<PointeeType>::value,
                  "Weak references to compactable objects are not allowed");
    const void* object = Extract(p);
    if (!object) {
      return;
    }
    VisitWeakRoot(object, TraceTrait<PointeeType>::GetTraceDescriptor(object),
                  &HandleWeak<AnyWeakPersistentType>, &p, p.Location());
  }

 protected:
  virtual void VisitRoot(const void*, TraceDescriptor, const SourceLocation&) {}
  virtual void VisitWeakRoot(const void* self, TraceDescriptor, WeakCallback,
                             const void* weak_root, const SourceLocation&) {}

 private:
  template <typename AnyPersistentType>
  static const void* Extract(AnyPersistentType& p) {
    using PointeeType = typename AnyPersistentType::PointeeType;
    static_assert(sizeof(PointeeType),
                  "Persistent's pointee type must be fully defined");
    static_assert(internal::IsGarbageCollectedOrMixinType<PointeeType>::value,
                  "Persistent's pointee type must be GarbageCollected or "
                  "GarbageCollectedMixin");
    return p.GetFromGC();
  }

  template <typename PointerType>
  static void HandleWeak(const LivenessBroker& info, const void* object) {
    const PointerType* weak = static_cast<const PointerType*>(object);
    if (!info.IsHeapObjectAlive(weak->GetFromGC())) {
      weak->ClearFromGC();
    }
  }
};

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_VISITOR_H_
