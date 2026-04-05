// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_GARBAGE_COLLECTED_H_
#define INCLUDE_CPPGC_GARBAGE_COLLECTED_H_

#include "cppgc/internal/api-constants.h"
#include "cppgc/platform.h"
#include "cppgc/trace-trait.h"
#include "cppgc/type-traits.h"

namespace cppgc {

class Visitor;

/**
 * Base class for managed objects. Only descendent types of `GarbageCollected`
 * can be constructed using `MakeGarbageCollected()`. Must be inherited from as
 * left-most base class.
 *
 * Types inheriting from GarbageCollected must provide a method of
 * signature `void Trace(cppgc::Visitor*) const` that dispatchs all managed
 * pointers to the visitor and delegates to garbage-collected base classes.
 * The method must be virtual if the type is not directly a child of
 * GarbageCollected and marked as final.
 *
 * \code
 * // Example using final class.
 * class FinalType final : public GarbageCollected<FinalType> {
 *  public:
 *   void Trace(cppgc::Visitor* visitor) const {
 *     // Dispatch using visitor->Trace(...);
 *   }
 * };
 *
 * // Example using non-final base class.
 * class NonFinalBase : public GarbageCollected<NonFinalBase> {
 *  public:
 *   virtual void Trace(cppgc::Visitor*) const {}
 * };
 *
 * class FinalChild final : public NonFinalBase {
 *  public:
 *   void Trace(cppgc::Visitor* visitor) const final {
 *     // Dispatch using visitor->Trace(...);
 *     NonFinalBase::Trace(visitor);
 *   }
 * };
 * \endcode
 */
template <typename T>
class GarbageCollected {
 public:
  using IsGarbageCollectedTypeMarker = void;
  using ParentMostGarbageCollectedType = T;

  // Must use MakeGarbageCollected.
  void* operator new(size_t) = delete;
  void* operator new[](size_t) = delete;
  // The garbage collector is taking care of reclaiming the object. Also,
  // virtual destructor requires an unambiguous, accessible 'operator delete'.
  void operator delete(void*) {
#ifdef V8_ENABLE_CHECKS
    internal::Fatal(
        "Manually deleting a garbage collected object is not allowed");
#endif  // V8_ENABLE_CHECKS
  }
  void operator delete[](void*) = delete;

 protected:
  GarbageCollected() = default;
};

/**
 * Base class for managed mixin objects. Such objects cannot be constructed
 * directly but must be mixed into the inheritance hierarchy of a
 * GarbageCollected object.
 *
 * Types inheriting from GarbageCollectedMixin must override a virtual method
 * of signature `void Trace(cppgc::Visitor*) const` that dispatchs all managed
 * pointers to the visitor and delegates to base classes.
 *
 * \code
 * class Mixin : public GarbageCollectedMixin {
 *  public:
 *   void Trace(cppgc::Visitor* visitor) const override {
 *     // Dispatch using visitor->Trace(...);
 *   }
 * };
 * \endcode
 */
class GarbageCollectedMixin {
 public:
  using IsGarbageCollectedMixinTypeMarker = void;

  /**
   * This Trace method must be overriden by objects inheriting from
   * GarbageCollectedMixin.
   */
  virtual void Trace(cppgc::Visitor*) const {}
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_GARBAGE_COLLECTED_H_
