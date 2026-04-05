// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_PREFINALIZER_H_
#define INCLUDE_CPPGC_PREFINALIZER_H_

#include "cppgc/internal/compiler-specific.h"
#include "cppgc/liveness-broker.h"

namespace cppgc {

namespace internal {

class V8_EXPORT PrefinalizerRegistration final {
 public:
  using Callback = bool (*)(const cppgc::LivenessBroker&, void*);

  PrefinalizerRegistration(void*, Callback);

  void* operator new(size_t, void* location) = delete;
  void* operator new(size_t) = delete;
};

}  // namespace internal

/**
 * Macro must be used in the private section of `Class` and registers a
 * prefinalization callback `void Class::PreFinalizer()`. The callback is
 * invoked on garbage collection after the collector has found an object to be
 * dead.
 *
 * Callback properties:
 * - The callback is invoked before a possible destructor for the corresponding
 *   object.
 * - The callback may access the whole object graph, irrespective of whether
 *   objects are considered dead or alive.
 * - The callback is invoked on the same thread as the object was created on.
 *
 * Example:
 * \code
 * class WithPrefinalizer : public GarbageCollected<WithPrefinalizer> {
 *   CPPGC_USING_PRE_FINALIZER(WithPrefinalizer, Dispose);
 *
 *  public:
 *   void Trace(Visitor*) const {}
 *   void Dispose() { prefinalizer_called = true; }
 *   ~WithPrefinalizer() {
 *     // prefinalizer_called == true
 *   }
 *  private:
 *   bool prefinalizer_called = false;
 * };
 * \endcode
 */
#define CPPGC_USING_PRE_FINALIZER(Class, PreFinalizer)                         \
 public:                                                                       \
  static bool InvokePreFinalizer(const cppgc::LivenessBroker& liveness_broker, \
                                 void* object) {                               \
    static_assert(cppgc::IsGarbageCollectedOrMixinTypeV<Class>,                \
                  "Only garbage collected objects can have prefinalizers");    \
    Class* self = static_cast<Class*>(object);                                 \
    if (liveness_broker.IsHeapObjectAlive(self)) return false;                 \
    self->PreFinalizer();                                                      \
    return true;                                                               \
  }                                                                            \
                                                                               \
 private:                                                                      \
  CPPGC_NO_UNIQUE_ADDRESS cppgc::internal::PrefinalizerRegistration            \
      prefinalizer_dummy_{this, Class::InvokePreFinalizer};                    \
  static_assert(true, "Force semicolon.")

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_PREFINALIZER_H_
