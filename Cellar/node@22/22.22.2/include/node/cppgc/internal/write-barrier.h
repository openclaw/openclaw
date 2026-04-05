// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_WRITE_BARRIER_H_
#define INCLUDE_CPPGC_INTERNAL_WRITE_BARRIER_H_

#include <cstddef>
#include <cstdint>

#include "cppgc/heap-handle.h"
#include "cppgc/heap-state.h"
#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/atomic-entry-flag.h"
#include "cppgc/internal/base-page-handle.h"
#include "cppgc/internal/member-storage.h"
#include "cppgc/platform.h"
#include "cppgc/sentinel-pointer.h"
#include "cppgc/trace-trait.h"
#include "v8config.h"  // NOLINT(build/include_directory)

#if defined(CPPGC_CAGED_HEAP)
#include "cppgc/internal/caged-heap-local-data.h"
#include "cppgc/internal/caged-heap.h"
#endif

namespace cppgc {

class HeapHandle;

namespace internal {

#if defined(CPPGC_CAGED_HEAP)
class WriteBarrierTypeForCagedHeapPolicy;
#else   // !CPPGC_CAGED_HEAP
class WriteBarrierTypeForNonCagedHeapPolicy;
#endif  // !CPPGC_CAGED_HEAP

class V8_EXPORT WriteBarrier final {
 public:
  enum class Type : uint8_t {
    kNone,
    kMarking,
    kGenerational,
  };

  enum class GenerationalBarrierType : uint8_t {
    kPreciseSlot,
    kPreciseUncompressedSlot,
    kImpreciseSlot,
  };

  struct Params {
    HeapHandle* heap = nullptr;
#if V8_ENABLE_CHECKS
    Type type = Type::kNone;
#endif  // !V8_ENABLE_CHECKS
#if defined(CPPGC_CAGED_HEAP)
    uintptr_t slot_offset = 0;
    uintptr_t value_offset = 0;
#endif  // CPPGC_CAGED_HEAP
  };

  enum class ValueMode {
    kValuePresent,
    kNoValuePresent,
  };

  // Returns the required write barrier for a given `slot` and `value`.
  static V8_INLINE Type GetWriteBarrierType(const void* slot, const void* value,
                                            Params& params);
  // Returns the required write barrier for a given `slot` and `value`.
  template <typename MemberStorage>
  static V8_INLINE Type GetWriteBarrierType(const void* slot, MemberStorage,
                                            Params& params);
  // Returns the required write barrier for a given `slot`.
  template <typename HeapHandleCallback>
  static V8_INLINE Type GetWriteBarrierType(const void* slot, Params& params,
                                            HeapHandleCallback callback);
  // Returns the required write barrier for a given  `value`.
  static V8_INLINE Type GetWriteBarrierType(const void* value, Params& params);

#ifdef CPPGC_SLIM_WRITE_BARRIER
  // A write barrier that combines `GenerationalBarrier()` and
  // `DijkstraMarkingBarrier()`. We only pass a single parameter here to clobber
  // as few registers as possible.
  template <WriteBarrierSlotType>
  static V8_NOINLINE void V8_PRESERVE_MOST
  CombinedWriteBarrierSlow(const void* slot);
#endif  // CPPGC_SLIM_WRITE_BARRIER

  static V8_INLINE void DijkstraMarkingBarrier(const Params& params,
                                               const void* object);
  static V8_INLINE void DijkstraMarkingBarrierRange(
      const Params& params, const void* first_element, size_t element_size,
      size_t number_of_elements, TraceCallback trace_callback);
  static V8_INLINE void SteeleMarkingBarrier(const Params& params,
                                             const void* object);
#if defined(CPPGC_YOUNG_GENERATION)
  template <GenerationalBarrierType>
  static V8_INLINE void GenerationalBarrier(const Params& params,
                                            const void* slot);
#else  // !CPPGC_YOUNG_GENERATION
  template <GenerationalBarrierType>
  static V8_INLINE void GenerationalBarrier(const Params& params,
                                            const void* slot){}
#endif  // CPPGC_YOUNG_GENERATION

#if V8_ENABLE_CHECKS
  static void CheckParams(Type expected_type, const Params& params);
#else   // !V8_ENABLE_CHECKS
  static void CheckParams(Type expected_type, const Params& params) {}
#endif  // !V8_ENABLE_CHECKS

  // The FlagUpdater class allows cppgc internal to update
  // |write_barrier_enabled_|.
  class FlagUpdater;
  static bool IsEnabled() { return write_barrier_enabled_.MightBeEntered(); }

 private:
  WriteBarrier() = delete;

#if defined(CPPGC_CAGED_HEAP)
  using WriteBarrierTypePolicy = WriteBarrierTypeForCagedHeapPolicy;
#else   // !CPPGC_CAGED_HEAP
  using WriteBarrierTypePolicy = WriteBarrierTypeForNonCagedHeapPolicy;
#endif  // !CPPGC_CAGED_HEAP

  static void DijkstraMarkingBarrierSlow(const void* value);
  static void DijkstraMarkingBarrierSlowWithSentinelCheck(const void* value);
  static void DijkstraMarkingBarrierRangeSlow(HeapHandle& heap_handle,
                                              const void* first_element,
                                              size_t element_size,
                                              size_t number_of_elements,
                                              TraceCallback trace_callback);
  static void SteeleMarkingBarrierSlow(const void* value);
  static void SteeleMarkingBarrierSlowWithSentinelCheck(const void* value);

#if defined(CPPGC_YOUNG_GENERATION)
  static CagedHeapLocalData& GetLocalData(HeapHandle&);
  static void GenerationalBarrierSlow(const CagedHeapLocalData& local_data,
                                      const AgeTable& age_table,
                                      const void* slot, uintptr_t value_offset,
                                      HeapHandle* heap_handle);
  static void GenerationalBarrierForUncompressedSlotSlow(
      const CagedHeapLocalData& local_data, const AgeTable& age_table,
      const void* slot, uintptr_t value_offset, HeapHandle* heap_handle);
  static void GenerationalBarrierForSourceObjectSlow(
      const CagedHeapLocalData& local_data, const void* object,
      HeapHandle* heap_handle);
#endif  // CPPGC_YOUNG_GENERATION

  static AtomicEntryFlag write_barrier_enabled_;
};

template <WriteBarrier::Type type>
V8_INLINE WriteBarrier::Type SetAndReturnType(WriteBarrier::Params& params) {
  if constexpr (type == WriteBarrier::Type::kNone)
    return WriteBarrier::Type::kNone;
#if V8_ENABLE_CHECKS
  params.type = type;
#endif  // !V8_ENABLE_CHECKS
  return type;
}

#if defined(CPPGC_CAGED_HEAP)
class V8_EXPORT WriteBarrierTypeForCagedHeapPolicy final {
 public:
  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, const void* value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    return ValueModeDispatch<value_mode>::Get(slot, value, params, callback);
  }

  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback,
            typename MemberStorage>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, MemberStorage value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    return ValueModeDispatch<value_mode>::Get(slot, value, params, callback);
  }

  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    return GetNoSlot(value, params, callback);
  }

 private:
  WriteBarrierTypeForCagedHeapPolicy() = delete;

  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type GetNoSlot(const void* value,
                                                WriteBarrier::Params& params,
                                                HeapHandleCallback) {
    const bool within_cage = CagedHeapBase::IsWithinCage(value);
    if (!within_cage) return WriteBarrier::Type::kNone;

    // We know that |value| points either within the normal page or to the
    // beginning of large-page, so extract the page header by bitmasking.
    BasePageHandle* page =
        BasePageHandle::FromPayload(const_cast<void*>(value));

    HeapHandle& heap_handle = page->heap_handle();
    if (V8_UNLIKELY(heap_handle.is_incremental_marking_in_progress())) {
      return SetAndReturnType<WriteBarrier::Type::kMarking>(params);
    }

    return SetAndReturnType<WriteBarrier::Type::kNone>(params);
  }

  template <WriteBarrier::ValueMode value_mode>
  struct ValueModeDispatch;
};

template <>
struct WriteBarrierTypeForCagedHeapPolicy::ValueModeDispatch<
    WriteBarrier::ValueMode::kValuePresent> {
  template <typename HeapHandleCallback, typename MemberStorage>
  static V8_INLINE WriteBarrier::Type Get(const void* slot,
                                          MemberStorage storage,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback) {
    if (V8_LIKELY(!WriteBarrier::IsEnabled()))
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);

    return BarrierEnabledGet(slot, storage.Load(), params);
  }

  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, const void* value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback) {
    if (V8_LIKELY(!WriteBarrier::IsEnabled()))
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);

    return BarrierEnabledGet(slot, value, params);
  }

 private:
  static V8_INLINE WriteBarrier::Type BarrierEnabledGet(
      const void* slot, const void* value, WriteBarrier::Params& params) {
    const bool within_cage = CagedHeapBase::AreWithinCage(slot, value);
    if (!within_cage) return WriteBarrier::Type::kNone;

    // We know that |value| points either within the normal page or to the
    // beginning of large-page, so extract the page header by bitmasking.
    BasePageHandle* page =
        BasePageHandle::FromPayload(const_cast<void*>(value));

    HeapHandle& heap_handle = page->heap_handle();
    if (V8_LIKELY(!heap_handle.is_incremental_marking_in_progress())) {
#if defined(CPPGC_YOUNG_GENERATION)
      if (!heap_handle.is_young_generation_enabled())
        return WriteBarrier::Type::kNone;
      params.heap = &heap_handle;
      params.slot_offset = CagedHeapBase::OffsetFromAddress(slot);
      params.value_offset = CagedHeapBase::OffsetFromAddress(value);
      return SetAndReturnType<WriteBarrier::Type::kGenerational>(params);
#else   // !CPPGC_YOUNG_GENERATION
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);
#endif  // !CPPGC_YOUNG_GENERATION
    }

    // Use marking barrier.
    params.heap = &heap_handle;
    return SetAndReturnType<WriteBarrier::Type::kMarking>(params);
  }
};

template <>
struct WriteBarrierTypeForCagedHeapPolicy::ValueModeDispatch<
    WriteBarrier::ValueMode::kNoValuePresent> {
  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, const void*,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    if (V8_LIKELY(!WriteBarrier::IsEnabled()))
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);

    HeapHandle& handle = callback();
#if defined(CPPGC_YOUNG_GENERATION)
    if (V8_LIKELY(!handle.is_incremental_marking_in_progress())) {
      if (!handle.is_young_generation_enabled()) {
        return WriteBarrier::Type::kNone;
      }
      params.heap = &handle;
      // Check if slot is on stack.
      if (V8_UNLIKELY(!CagedHeapBase::IsWithinCage(slot))) {
        return SetAndReturnType<WriteBarrier::Type::kNone>(params);
      }
      params.slot_offset = CagedHeapBase::OffsetFromAddress(slot);
      return SetAndReturnType<WriteBarrier::Type::kGenerational>(params);
    }
#else   // !defined(CPPGC_YOUNG_GENERATION)
    if (V8_UNLIKELY(!handle.is_incremental_marking_in_progress())) {
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);
    }
#endif  // !defined(CPPGC_YOUNG_GENERATION)
    params.heap = &handle;
    return SetAndReturnType<WriteBarrier::Type::kMarking>(params);
  }
};

#endif  // CPPGC_CAGED_HEAP

class V8_EXPORT WriteBarrierTypeForNonCagedHeapPolicy final {
 public:
  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, const void* value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    return ValueModeDispatch<value_mode>::Get(slot, value, params, callback);
  }

  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* slot, RawPointer value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    return ValueModeDispatch<value_mode>::Get(slot, value.Load(), params,
                                              callback);
  }

  template <WriteBarrier::ValueMode value_mode, typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void* value,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    // The slot will never be used in `Get()` below.
    return Get<WriteBarrier::ValueMode::kValuePresent>(nullptr, value, params,
                                                       callback);
  }

 private:
  template <WriteBarrier::ValueMode value_mode>
  struct ValueModeDispatch;

  WriteBarrierTypeForNonCagedHeapPolicy() = delete;
};

template <>
struct WriteBarrierTypeForNonCagedHeapPolicy::ValueModeDispatch<
    WriteBarrier::ValueMode::kValuePresent> {
  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void*, const void* object,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    // The following check covers nullptr as well as sentinel pointer.
    if (object <= static_cast<void*>(kSentinelPointer)) {
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);
    }
    if (V8_LIKELY(!WriteBarrier::IsEnabled())) {
      return SetAndReturnType<WriteBarrier::Type::kNone>(params);
    }
    // We know that |object| is within the normal page or in the beginning of a
    // large page, so extract the page header by bitmasking.
    BasePageHandle* page =
        BasePageHandle::FromPayload(const_cast<void*>(object));

    HeapHandle& heap_handle = page->heap_handle();
    if (V8_LIKELY(heap_handle.is_incremental_marking_in_progress())) {
      return SetAndReturnType<WriteBarrier::Type::kMarking>(params);
    }
    return SetAndReturnType<WriteBarrier::Type::kNone>(params);
  }
};

template <>
struct WriteBarrierTypeForNonCagedHeapPolicy::ValueModeDispatch<
    WriteBarrier::ValueMode::kNoValuePresent> {
  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrier::Type Get(const void*, const void*,
                                          WriteBarrier::Params& params,
                                          HeapHandleCallback callback) {
    if (V8_UNLIKELY(WriteBarrier::IsEnabled())) {
      HeapHandle& handle = callback();
      if (V8_LIKELY(handle.is_incremental_marking_in_progress())) {
        params.heap = &handle;
        return SetAndReturnType<WriteBarrier::Type::kMarking>(params);
      }
    }
    return WriteBarrier::Type::kNone;
  }
};

// static
WriteBarrier::Type WriteBarrier::GetWriteBarrierType(
    const void* slot, const void* value, WriteBarrier::Params& params) {
  return WriteBarrierTypePolicy::Get<ValueMode::kValuePresent>(slot, value,
                                                               params, []() {});
}

// static
template <typename MemberStorage>
WriteBarrier::Type WriteBarrier::GetWriteBarrierType(
    const void* slot, MemberStorage value, WriteBarrier::Params& params) {
  return WriteBarrierTypePolicy::Get<ValueMode::kValuePresent>(slot, value,
                                                               params, []() {});
}

// static
template <typename HeapHandleCallback>
WriteBarrier::Type WriteBarrier::GetWriteBarrierType(
    const void* slot, WriteBarrier::Params& params,
    HeapHandleCallback callback) {
  return WriteBarrierTypePolicy::Get<ValueMode::kNoValuePresent>(
      slot, nullptr, params, callback);
}

// static
WriteBarrier::Type WriteBarrier::GetWriteBarrierType(
    const void* value, WriteBarrier::Params& params) {
  return WriteBarrierTypePolicy::Get<ValueMode::kValuePresent>(value, params,
                                                               []() {});
}

// static
void WriteBarrier::DijkstraMarkingBarrier(const Params& params,
                                          const void* object) {
  CheckParams(Type::kMarking, params);
#if defined(CPPGC_CAGED_HEAP)
  // Caged heap already filters out sentinels.
  DijkstraMarkingBarrierSlow(object);
#else   // !CPPGC_CAGED_HEAP
  DijkstraMarkingBarrierSlowWithSentinelCheck(object);
#endif  // !CPPGC_CAGED_HEAP
}

// static
void WriteBarrier::DijkstraMarkingBarrierRange(const Params& params,
                                               const void* first_element,
                                               size_t element_size,
                                               size_t number_of_elements,
                                               TraceCallback trace_callback) {
  CheckParams(Type::kMarking, params);
  DijkstraMarkingBarrierRangeSlow(*params.heap, first_element, element_size,
                                  number_of_elements, trace_callback);
}

// static
void WriteBarrier::SteeleMarkingBarrier(const Params& params,
                                        const void* object) {
  CheckParams(Type::kMarking, params);
#if defined(CPPGC_CAGED_HEAP)
  // Caged heap already filters out sentinels.
  SteeleMarkingBarrierSlow(object);
#else   // !CPPGC_CAGED_HEAP
  SteeleMarkingBarrierSlowWithSentinelCheck(object);
#endif  // !CPPGC_CAGED_HEAP
}

#if defined(CPPGC_YOUNG_GENERATION)

// static
template <WriteBarrier::GenerationalBarrierType type>
void WriteBarrier::GenerationalBarrier(const Params& params, const void* slot) {
  CheckParams(Type::kGenerational, params);

  const CagedHeapLocalData& local_data = CagedHeapLocalData::Get();
  const AgeTable& age_table = local_data.age_table;

  // Bail out if the slot (precise or imprecise) is in young generation.
  if (V8_LIKELY(age_table.GetAge(params.slot_offset) == AgeTable::Age::kYoung))
    return;

  // Dispatch between different types of barriers.
  // TODO(chromium:1029379): Consider reload local_data in the slow path to
  // reduce register pressure.
  if constexpr (type == GenerationalBarrierType::kPreciseSlot) {
    GenerationalBarrierSlow(local_data, age_table, slot, params.value_offset,
                            params.heap);
  } else if constexpr (type ==
                       GenerationalBarrierType::kPreciseUncompressedSlot) {
    GenerationalBarrierForUncompressedSlotSlow(
        local_data, age_table, slot, params.value_offset, params.heap);
  } else {
    GenerationalBarrierForSourceObjectSlow(local_data, slot, params.heap);
  }
}

#endif  // !CPPGC_YOUNG_GENERATION

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_WRITE_BARRIER_H_
