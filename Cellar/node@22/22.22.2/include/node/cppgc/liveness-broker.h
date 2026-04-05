// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_LIVENESS_BROKER_H_
#define INCLUDE_CPPGC_LIVENESS_BROKER_H_

#include "cppgc/heap.h"
#include "cppgc/member.h"
#include "cppgc/sentinel-pointer.h"
#include "cppgc/trace-trait.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

namespace internal {
class LivenessBrokerFactory;
}  // namespace internal

/**
 * The broker is passed to weak callbacks to allow (temporarily) querying
 * the liveness state of an object. References to non-live objects must be
 * cleared when `IsHeapObjectAlive()` returns false.
 *
 * \code
 * class GCedWithCustomWeakCallback final
 *   : public GarbageCollected<GCedWithCustomWeakCallback> {
 *  public:
 *   UntracedMember<Bar> bar;
 *
 *   void CustomWeakCallbackMethod(const LivenessBroker& broker) {
 *     if (!broker.IsHeapObjectAlive(bar))
 *       bar = nullptr;
 *   }
 *
 *   void Trace(cppgc::Visitor* visitor) const {
 *     visitor->RegisterWeakCallbackMethod<
 *         GCedWithCustomWeakCallback,
 *         &GCedWithCustomWeakCallback::CustomWeakCallbackMethod>(this);
 *   }
 * };
 * \endcode
 */
class V8_EXPORT LivenessBroker final {
 public:
  template <typename T>
  bool IsHeapObjectAlive(const T* object) const {
    // - nullptr objects are considered alive to allow weakness to be used from
    // stack while running into a conservative GC. Treating nullptr as dead
    // would mean that e.g. custom collections could not be strongified on
    // stack.
    // - Sentinel pointers are also preserved in weakness and not cleared.
    return !object || object == kSentinelPointer ||
           IsHeapObjectAliveImpl(
               TraceTrait<T>::GetTraceDescriptor(object).base_object_payload);
  }

  template <typename T>
  bool IsHeapObjectAlive(const WeakMember<T>& weak_member) const {
    return IsHeapObjectAlive<T>(weak_member.Get());
  }

  template <typename T>
  bool IsHeapObjectAlive(const UntracedMember<T>& untraced_member) const {
    return IsHeapObjectAlive<T>(untraced_member.Get());
  }

 private:
  LivenessBroker() = default;

  bool IsHeapObjectAliveImpl(const void*) const;

  friend class internal::LivenessBrokerFactory;
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_LIVENESS_BROKER_H_
