// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_CAGED_HEAP_LOCAL_DATA_H_
#define INCLUDE_CPPGC_INTERNAL_CAGED_HEAP_LOCAL_DATA_H_

#include <array>
#include <cstddef>
#include <cstdint>

#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/caged-heap.h"
#include "cppgc/internal/logging.h"
#include "cppgc/platform.h"
#include "v8config.h"  // NOLINT(build/include_directory)

#if __cpp_lib_bitopts
#include <bit>
#endif  // __cpp_lib_bitopts

#if defined(CPPGC_CAGED_HEAP)

namespace cppgc {
namespace internal {

class HeapBase;
class HeapBaseHandle;

#if defined(CPPGC_YOUNG_GENERATION)

// AgeTable is the bytemap needed for the fast generation check in the write
// barrier. AgeTable contains entries that correspond to 4096 bytes memory
// regions (cards). Each entry in the table represents generation of the objects
// that reside on the corresponding card (young, old or mixed).
class V8_EXPORT AgeTable final {
  static constexpr size_t kRequiredSize = 1 * api_constants::kMB;
  static constexpr size_t kAllocationGranularity =
      api_constants::kAllocationGranularity;

 public:
  // Represents age of the objects living on a single card.
  enum class Age : uint8_t { kOld, kYoung, kMixed };
  // When setting age for a range, consider or ignore ages of the adjacent
  // cards.
  enum class AdjacentCardsPolicy : uint8_t { kConsider, kIgnore };

  static constexpr size_t kCardSizeInBytes =
      api_constants::kCagedHeapDefaultReservationSize / kRequiredSize;

  static constexpr size_t CalculateAgeTableSizeForHeapSize(size_t heap_size) {
    return heap_size / kCardSizeInBytes;
  }

  void SetAge(uintptr_t cage_offset, Age age) {
    table_[card(cage_offset)] = age;
  }

  V8_INLINE Age GetAge(uintptr_t cage_offset) const {
    return table_[card(cage_offset)];
  }

  void SetAgeForRange(uintptr_t cage_offset_begin, uintptr_t cage_offset_end,
                      Age age, AdjacentCardsPolicy adjacent_cards_policy);

  Age GetAgeForRange(uintptr_t cage_offset_begin,
                     uintptr_t cage_offset_end) const;

  void ResetForTesting();

 private:
  V8_INLINE size_t card(uintptr_t offset) const {
    constexpr size_t kGranularityBits =
#if __cpp_lib_bitopts
        std::countr_zero(static_cast<uint32_t>(kCardSizeInBytes));
#elif V8_HAS_BUILTIN_CTZ
        __builtin_ctz(static_cast<uint32_t>(kCardSizeInBytes));
#else   //! V8_HAS_BUILTIN_CTZ
        // Hardcode and check with assert.
#if defined(CPPGC_2GB_CAGE)
        11;
#else   // !defined(CPPGC_2GB_CAGE)
        12;
#endif  // !defined(CPPGC_2GB_CAGE)
#endif  // !V8_HAS_BUILTIN_CTZ
    static_assert((1 << kGranularityBits) == kCardSizeInBytes);
    const size_t entry = offset >> kGranularityBits;
    CPPGC_DCHECK(CagedHeapBase::GetAgeTableSize() > entry);
    return entry;
  }

#if defined(V8_CC_GNU)
  // gcc disallows flexible arrays in otherwise empty classes.
  Age table_[0];
#else   // !defined(V8_CC_GNU)
  Age table_[];
#endif  // !defined(V8_CC_GNU)
};

#endif  // CPPGC_YOUNG_GENERATION

struct CagedHeapLocalData final {
  V8_INLINE static CagedHeapLocalData& Get() {
    return *reinterpret_cast<CagedHeapLocalData*>(CagedHeapBase::GetBase());
  }

  static constexpr size_t CalculateLocalDataSizeForHeapSize(size_t heap_size) {
    return AgeTable::CalculateAgeTableSizeForHeapSize(heap_size);
  }

#if defined(CPPGC_YOUNG_GENERATION)
  AgeTable age_table;
#endif
};

}  // namespace internal
}  // namespace cppgc

#endif  // defined(CPPGC_CAGED_HEAP)

#endif  // INCLUDE_CPPGC_INTERNAL_CAGED_HEAP_LOCAL_DATA_H_
