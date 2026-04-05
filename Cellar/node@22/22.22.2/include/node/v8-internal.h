// Copyright 2018 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_INTERNAL_H_
#define INCLUDE_V8_INTERNAL_H_

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <atomic>
#include <iterator>
#include <memory>
#include <type_traits>

#include "v8config.h"  // NOLINT(build/include_directory)

namespace v8 {

class Array;
class Context;
class Data;
class Isolate;

namespace internal {

class Heap;
class Isolate;

typedef uintptr_t Address;
static constexpr Address kNullAddress = 0;

constexpr int KB = 1024;
constexpr int MB = KB * 1024;
constexpr int GB = MB * 1024;
#ifdef V8_TARGET_ARCH_X64
constexpr size_t TB = size_t{GB} * 1024;
#endif

/**
 * Configuration of tagging scheme.
 */
const int kApiSystemPointerSize = sizeof(void*);
const int kApiDoubleSize = sizeof(double);
const int kApiInt32Size = sizeof(int32_t);
const int kApiInt64Size = sizeof(int64_t);
const int kApiSizetSize = sizeof(size_t);

// Tag information for HeapObject.
const int kHeapObjectTag = 1;
const int kWeakHeapObjectTag = 3;
const int kHeapObjectTagSize = 2;
const intptr_t kHeapObjectTagMask = (1 << kHeapObjectTagSize) - 1;
const intptr_t kHeapObjectReferenceTagMask = 1 << (kHeapObjectTagSize - 1);

// Tag information for fowarding pointers stored in object headers.
// 0b00 at the lowest 2 bits in the header indicates that the map word is a
// forwarding pointer.
const int kForwardingTag = 0;
const int kForwardingTagSize = 2;
const intptr_t kForwardingTagMask = (1 << kForwardingTagSize) - 1;

// Tag information for Smi.
const int kSmiTag = 0;
const int kSmiTagSize = 1;
const intptr_t kSmiTagMask = (1 << kSmiTagSize) - 1;

template <size_t tagged_ptr_size>
struct SmiTagging;

constexpr intptr_t kIntptrAllBitsSet = intptr_t{-1};
constexpr uintptr_t kUintptrAllBitsSet =
    static_cast<uintptr_t>(kIntptrAllBitsSet);

// Smi constants for systems where tagged pointer is a 32-bit value.
template <>
struct SmiTagging<4> {
  enum { kSmiShiftSize = 0, kSmiValueSize = 31 };

  static constexpr intptr_t kSmiMinValue =
      static_cast<intptr_t>(kUintptrAllBitsSet << (kSmiValueSize - 1));
  static constexpr intptr_t kSmiMaxValue = -(kSmiMinValue + 1);

  V8_INLINE static constexpr int SmiToInt(Address value) {
    int shift_bits = kSmiTagSize + kSmiShiftSize;
    // Truncate and shift down (requires >> to be sign extending).
    return static_cast<int32_t>(static_cast<uint32_t>(value)) >> shift_bits;
  }
  V8_INLINE static constexpr bool IsValidSmi(intptr_t value) {
    // Is value in range [kSmiMinValue, kSmiMaxValue].
    // Use unsigned operations in order to avoid undefined behaviour in case of
    // signed integer overflow.
    return (static_cast<uintptr_t>(value) -
            static_cast<uintptr_t>(kSmiMinValue)) <=
           (static_cast<uintptr_t>(kSmiMaxValue) -
            static_cast<uintptr_t>(kSmiMinValue));
  }
};

// Smi constants for systems where tagged pointer is a 64-bit value.
template <>
struct SmiTagging<8> {
  enum { kSmiShiftSize = 31, kSmiValueSize = 32 };

  static constexpr intptr_t kSmiMinValue =
      static_cast<intptr_t>(kUintptrAllBitsSet << (kSmiValueSize - 1));
  static constexpr intptr_t kSmiMaxValue = -(kSmiMinValue + 1);

  V8_INLINE static constexpr int SmiToInt(Address value) {
    int shift_bits = kSmiTagSize + kSmiShiftSize;
    // Shift down and throw away top 32 bits.
    return static_cast<int>(static_cast<intptr_t>(value) >> shift_bits);
  }
  V8_INLINE static constexpr bool IsValidSmi(intptr_t value) {
    // To be representable as a long smi, the value must be a 32-bit integer.
    return (value == static_cast<int32_t>(value));
  }
};

#ifdef V8_COMPRESS_POINTERS
// See v8:7703 or src/common/ptr-compr-inl.h for details about pointer
// compression.
constexpr size_t kPtrComprCageReservationSize = size_t{1} << 32;
constexpr size_t kPtrComprCageBaseAlignment = size_t{1} << 32;

static_assert(
    kApiSystemPointerSize == kApiInt64Size,
    "Pointer compression can be enabled only for 64-bit architectures");
const int kApiTaggedSize = kApiInt32Size;
#else
const int kApiTaggedSize = kApiSystemPointerSize;
#endif

constexpr bool PointerCompressionIsEnabled() {
  return kApiTaggedSize != kApiSystemPointerSize;
}

#ifdef V8_31BIT_SMIS_ON_64BIT_ARCH
using PlatformSmiTagging = SmiTagging<kApiInt32Size>;
#else
using PlatformSmiTagging = SmiTagging<kApiTaggedSize>;
#endif

// TODO(ishell): Consinder adding kSmiShiftBits = kSmiShiftSize + kSmiTagSize
// since it's used much more often than the inividual constants.
const int kSmiShiftSize = PlatformSmiTagging::kSmiShiftSize;
const int kSmiValueSize = PlatformSmiTagging::kSmiValueSize;
const int kSmiMinValue = static_cast<int>(PlatformSmiTagging::kSmiMinValue);
const int kSmiMaxValue = static_cast<int>(PlatformSmiTagging::kSmiMaxValue);
constexpr bool SmiValuesAre31Bits() { return kSmiValueSize == 31; }
constexpr bool SmiValuesAre32Bits() { return kSmiValueSize == 32; }
constexpr bool Is64() { return kApiSystemPointerSize == sizeof(int64_t); }

V8_INLINE static constexpr Address IntToSmi(int value) {
  return (static_cast<Address>(value) << (kSmiTagSize + kSmiShiftSize)) |
         kSmiTag;
}

/*
 * Sandbox related types, constants, and functions.
 */
constexpr bool SandboxIsEnabled() {
#ifdef V8_ENABLE_SANDBOX
  return true;
#else
  return false;
#endif
}

// SandboxedPointers are guaranteed to point into the sandbox. This is achieved
// for example by storing them as offset rather than as raw pointers.
using SandboxedPointer_t = Address;

#ifdef V8_ENABLE_SANDBOX

// Size of the sandbox, excluding the guard regions surrounding it.
#if defined(V8_TARGET_OS_ANDROID)
// On Android, most 64-bit devices seem to be configured with only 39 bits of
// virtual address space for userspace. As such, limit the sandbox to 128GB (a
// quarter of the total available address space).
constexpr size_t kSandboxSizeLog2 = 37;  // 128 GB
#elif defined(V8_TARGET_ARCH_LOONG64)
// Some Linux distros on LoongArch64 configured with only 40 bits of virtual
// address space for userspace. Limit the sandbox to 256GB here.
constexpr size_t kSandboxSizeLog2 = 38;  // 256 GB
#else
// Everywhere else use a 1TB sandbox.
constexpr size_t kSandboxSizeLog2 = 40;  // 1 TB
#endif  // V8_TARGET_OS_ANDROID
constexpr size_t kSandboxSize = 1ULL << kSandboxSizeLog2;

// Required alignment of the sandbox. For simplicity, we require the
// size of the guard regions to be a multiple of this, so that this specifies
// the alignment of the sandbox including and excluding surrounding guard
// regions. The alignment requirement is due to the pointer compression cage
// being located at the start of the sandbox.
constexpr size_t kSandboxAlignment = kPtrComprCageBaseAlignment;

// Sandboxed pointers are stored inside the heap as offset from the sandbox
// base shifted to the left. This way, it is guaranteed that the offset is
// smaller than the sandbox size after shifting it to the right again. This
// constant specifies the shift amount.
constexpr uint64_t kSandboxedPointerShift = 64 - kSandboxSizeLog2;

// Size of the guard regions surrounding the sandbox. This assumes a worst-case
// scenario of a 32-bit unsigned index used to access an array of 64-bit
// values.
constexpr size_t kSandboxGuardRegionSize = 32ULL * GB;

static_assert((kSandboxGuardRegionSize % kSandboxAlignment) == 0,
              "The size of the guard regions around the sandbox must be a "
              "multiple of its required alignment.");

// On OSes where reserving virtual memory is too expensive to reserve the
// entire address space backing the sandbox, notably Windows pre 8.1, we create
// a partially reserved sandbox that doesn't actually reserve most of the
// memory, and so doesn't have the desired security properties as unrelated
// memory allocations could end up inside of it, but which still ensures that
// objects that should be located inside the sandbox are allocated within
// kSandboxSize bytes from the start of the sandbox. The minimum size of the
// region that is actually reserved for such a sandbox is specified by this
// constant and should be big enough to contain the pointer compression cage as
// well as the ArrayBuffer partition.
constexpr size_t kSandboxMinimumReservationSize = 8ULL * GB;

static_assert(kSandboxMinimumReservationSize > kPtrComprCageReservationSize,
              "The minimum reservation size for a sandbox must be larger than "
              "the pointer compression cage contained within it.");

// The maximum buffer size allowed inside the sandbox. This is mostly dependent
// on the size of the guard regions around the sandbox: an attacker must not be
// able to construct a buffer that appears larger than the guard regions and
// thereby "reach out of" the sandbox.
constexpr size_t kMaxSafeBufferSizeForSandbox = 32ULL * GB - 1;
static_assert(kMaxSafeBufferSizeForSandbox <= kSandboxGuardRegionSize,
              "The maximum allowed buffer size must not be larger than the "
              "sandbox's guard regions");

constexpr size_t kBoundedSizeShift = 29;
static_assert(1ULL << (64 - kBoundedSizeShift) ==
                  kMaxSafeBufferSizeForSandbox + 1,
              "The maximum size of a BoundedSize must be synchronized with the "
              "kMaxSafeBufferSizeForSandbox");

#endif  // V8_ENABLE_SANDBOX

#ifdef V8_COMPRESS_POINTERS

#ifdef V8_TARGET_OS_ANDROID
// The size of the virtual memory reservation for an external pointer table.
// This determines the maximum number of entries in a table. Using a maximum
// size allows omitting bounds checks on table accesses if the indices are
// guaranteed (e.g. through shifting) to be below the maximum index. This
// value must be a power of two.
constexpr size_t kExternalPointerTableReservationSize = 512 * MB;

// The external pointer table indices stored in HeapObjects as external
// pointers are shifted to the left by this amount to guarantee that they are
// smaller than the maximum table size.
constexpr uint32_t kExternalPointerIndexShift = 6;
#else
constexpr size_t kExternalPointerTableReservationSize = 1024 * MB;
constexpr uint32_t kExternalPointerIndexShift = 5;
#endif  // V8_TARGET_OS_ANDROID

// The maximum number of entries in an external pointer table.
constexpr int kExternalPointerTableEntrySize = 8;
constexpr int kExternalPointerTableEntrySizeLog2 = 3;
constexpr size_t kMaxExternalPointers =
    kExternalPointerTableReservationSize / kExternalPointerTableEntrySize;
static_assert((1 << (32 - kExternalPointerIndexShift)) == kMaxExternalPointers,
              "kExternalPointerTableReservationSize and "
              "kExternalPointerIndexShift don't match");

#else  // !V8_COMPRESS_POINTERS

// Needed for the V8.SandboxedExternalPointersCount histogram.
constexpr size_t kMaxExternalPointers = 0;

#endif  // V8_COMPRESS_POINTERS

// A ExternalPointerHandle represents a (opaque) reference to an external
// pointer that can be stored inside the sandbox. A ExternalPointerHandle has
// meaning only in combination with an (active) Isolate as it references an
// external pointer stored in the currently active Isolate's
// ExternalPointerTable. Internally, an ExternalPointerHandles is simply an
// index into an ExternalPointerTable that is shifted to the left to guarantee
// that it is smaller than the size of the table.
using ExternalPointerHandle = uint32_t;

// ExternalPointers point to objects located outside the sandbox. When the V8
// sandbox is enabled, these are stored on heap as ExternalPointerHandles,
// otherwise they are simply raw pointers.
#ifdef V8_ENABLE_SANDBOX
using ExternalPointer_t = ExternalPointerHandle;
#else
using ExternalPointer_t = Address;
#endif

constexpr ExternalPointer_t kNullExternalPointer = 0;
constexpr ExternalPointerHandle kNullExternalPointerHandle = 0;

//
// External Pointers.
//
// When the sandbox is enabled, external pointers are stored in an external
// pointer table and are referenced from HeapObjects through an index (a
// "handle"). When stored in the table, the pointers are tagged with per-type
// tags to prevent type confusion attacks between different external objects.
// Besides type information bits, these tags also contain the GC marking bit
// which indicates whether the pointer table entry is currently alive. When a
// pointer is written into the table, the tag is ORed into the top bits. When
// that pointer is later loaded from the table, it is ANDed with the inverse of
// the expected tag. If the expected and actual type differ, this will leave
// some of the top bits of the pointer set, rendering the pointer inaccessible.
// The AND operation also removes the GC marking bit from the pointer.
//
// The tags are constructed such that UNTAG(TAG(0, T1), T2) != 0 for any two
// (distinct) tags T1 and T2. In practice, this is achieved by generating tags
// that all have the same number of zeroes and ones but different bit patterns.
// With N type tag bits, this allows for (N choose N/2) possible type tags.
// Besides the type tag bits, the tags also have the GC marking bit set so that
// the marking bit is automatically set when a pointer is written into the
// external pointer table (in which case it is clearly alive) and is cleared
// when the pointer is loaded. The exception to this is the free entry tag,
// which doesn't have the mark bit set, as the entry is not alive. This
// construction allows performing the type check and removing GC marking bits
// from the pointer in one efficient operation (bitwise AND). The number of
// available bits is limited in the following way: on x64, bits [47, 64) are
// generally available for tagging (userspace has 47 address bits available).
// On Arm64, userspace typically has a 40 or 48 bit address space. However, due
// to top-byte ignore (TBI) and memory tagging (MTE), the top byte is unusable
// for type checks as type-check failures would go unnoticed or collide with
// MTE bits. Some bits of the top byte can, however, still be used for the GC
// marking bit. The bits available for the type tags are therefore limited to
// [48, 56), i.e. (8 choose 4) = 70 different types.
// The following options exist to increase the number of possible types:
// - Using multiple ExternalPointerTables since tags can safely be reused
//   across different tables
// - Using "extended" type checks, where additional type information is stored
//   either in an adjacent pointer table entry or at the pointed-to location
// - Using a different tagging scheme, for example based on XOR which would
//   allow for 2**8 different tags but require a separate operation to remove
//   the marking bit
//
// The external pointer sandboxing mechanism ensures that every access to an
// external pointer field will result in a valid pointer of the expected type
// even in the presence of an attacker able to corrupt memory inside the
// sandbox. However, if any data related to the external object is stored
// inside the sandbox it may still be corrupted and so must be validated before
// use or moved into the external object. Further, an attacker will always be
// able to substitute different external pointers of the same type for each
// other. Therefore, code using external pointers must be written in a
// "substitution-safe" way, i.e. it must always be possible to substitute
// external pointers of the same type without causing memory corruption outside
// of the sandbox. Generally this is achieved by referencing any group of
// related external objects through a single external pointer.
//
// Currently we use bit 62 for the marking bit which should always be unused as
// it's part of the non-canonical address range. When Arm's top-byte ignore
// (TBI) is enabled, this bit will be part of the ignored byte, and we assume
// that the Embedder is not using this byte (really only this one bit) for any
// other purpose. This bit also does not collide with the memory tagging
// extension (MTE) which would use bits [56, 60).
//
// External pointer tables are also available even when the sandbox is off but
// pointer compression is on. In that case, the mechanism can be used to easy
// alignment requirements as it turns unaligned 64-bit raw pointers into
// aligned 32-bit indices. To "opt-in" to the external pointer table mechanism
// for this purpose, instead of using the ExternalPointer accessors one needs to
// use ExternalPointerHandles directly and use them to access the pointers in an
// ExternalPointerTable.
constexpr uint64_t kExternalPointerMarkBit = 1ULL << 62;
constexpr uint64_t kExternalPointerTagMask = 0x40ff000000000000;
constexpr uint64_t kExternalPointerTagMaskWithoutMarkBit = 0xff000000000000;
constexpr uint64_t kExternalPointerTagShift = 48;

// All possible 8-bit type tags.
// These are sorted so that tags can be grouped together and it can efficiently
// be checked if a tag belongs to a given group. See for example the
// IsSharedExternalPointerType routine.
constexpr uint64_t kAllExternalPointerTypeTags[] = {
    0b00001111, 0b00010111, 0b00011011, 0b00011101, 0b00011110, 0b00100111,
    0b00101011, 0b00101101, 0b00101110, 0b00110011, 0b00110101, 0b00110110,
    0b00111001, 0b00111010, 0b00111100, 0b01000111, 0b01001011, 0b01001101,
    0b01001110, 0b01010011, 0b01010101, 0b01010110, 0b01011001, 0b01011010,
    0b01011100, 0b01100011, 0b01100101, 0b01100110, 0b01101001, 0b01101010,
    0b01101100, 0b01110001, 0b01110010, 0b01110100, 0b01111000, 0b10000111,
    0b10001011, 0b10001101, 0b10001110, 0b10010011, 0b10010101, 0b10010110,
    0b10011001, 0b10011010, 0b10011100, 0b10100011, 0b10100101, 0b10100110,
    0b10101001, 0b10101010, 0b10101100, 0b10110001, 0b10110010, 0b10110100,
    0b10111000, 0b11000011, 0b11000101, 0b11000110, 0b11001001, 0b11001010,
    0b11001100, 0b11010001, 0b11010010, 0b11010100, 0b11011000, 0b11100001,
    0b11100010, 0b11100100, 0b11101000, 0b11110000};

#define TAG(i)                                                    \
  ((kAllExternalPointerTypeTags[i] << kExternalPointerTagShift) | \
   kExternalPointerMarkBit)

// clang-format off

// When adding new tags, please ensure that the code using these tags is
// "substitution-safe", i.e. still operate safely if external pointers of the
// same type are swapped by an attacker. See comment above for more details.

// Shared external pointers are owned by the shared Isolate and stored in the
// shared external pointer table associated with that Isolate, where they can
// be accessed from multiple threads at the same time. The objects referenced
// in this way must therefore always be thread-safe.
#define SHARED_EXTERNAL_POINTER_TAGS(V)                 \
  V(kFirstSharedTag,                            TAG(0)) \
  V(kWaiterQueueNodeTag,                        TAG(0)) \
  V(kExternalStringResourceTag,                 TAG(1)) \
  V(kExternalStringResourceDataTag,             TAG(2)) \
  V(kLastSharedTag,                             TAG(2))

// External pointers using these tags are kept in a per-Isolate external
// pointer table and can only be accessed when this Isolate is active.
#define PER_ISOLATE_EXTERNAL_POINTER_TAGS(V)             \
  V(kForeignForeignAddressTag,                  TAG(10)) \
  V(kNativeContextMicrotaskQueueTag,            TAG(11)) \
  V(kEmbedderDataSlotPayloadTag,                TAG(12)) \
/* This tag essentially stands for a `void*` pointer in the V8 API, and */ \
/* it is the Embedder's responsibility to ensure type safety (against */   \
/* substitution) and lifetime validity of these objects. */                \
  V(kExternalObjectValueTag,                    TAG(13)) \
  V(kFunctionTemplateInfoCallbackTag,           TAG(14)) \
  V(kAccessorInfoGetterTag,                     TAG(15)) \
  V(kAccessorInfoSetterTag,                     TAG(16)) \
  V(kWasmInternalFunctionCallTargetTag,         TAG(17)) \
  V(kWasmTypeInfoNativeTypeTag,                 TAG(18)) \
  V(kWasmExportedFunctionDataSignatureTag,      TAG(19)) \
  V(kWasmContinuationJmpbufTag,                 TAG(20)) \
  V(kWasmIndirectFunctionTargetTag,             TAG(21)) \
  V(kArrayBufferExtensionTag,                   TAG(22))

// All external pointer tags.
#define ALL_EXTERNAL_POINTER_TAGS(V) \
  SHARED_EXTERNAL_POINTER_TAGS(V)    \
  PER_ISOLATE_EXTERNAL_POINTER_TAGS(V)

#define EXTERNAL_POINTER_TAG_ENUM(Name, Tag) Name = Tag,
#define MAKE_TAG(HasMarkBit, TypeTag)                             \
  ((static_cast<uint64_t>(TypeTag) << kExternalPointerTagShift) | \
  (HasMarkBit ? kExternalPointerMarkBit : 0))
enum ExternalPointerTag : uint64_t {
  // Empty tag value. Mostly used as placeholder.
  kExternalPointerNullTag =            MAKE_TAG(1, 0b00000000),
  // External pointer tag that will match any external pointer. Use with care!
  kAnyExternalPointerTag =             MAKE_TAG(1, 0b11111111),
  // The free entry tag has all type bits set so every type check with a
  // different type fails. It also doesn't have the mark bit set as free
  // entries are (by definition) not alive.
  kExternalPointerFreeEntryTag =       MAKE_TAG(0, 0b11111111),
  // Evacuation entries are used during external pointer table compaction.
  kExternalPointerEvacuationEntryTag = MAKE_TAG(1, 0b11100111),

  ALL_EXTERNAL_POINTER_TAGS(EXTERNAL_POINTER_TAG_ENUM)
};

#undef MAKE_TAG
#undef TAG
#undef EXTERNAL_POINTER_TAG_ENUM

// clang-format on

// True if the external pointer must be accessed from the shared isolate's
// external pointer table.
V8_INLINE static constexpr bool IsSharedExternalPointerType(
    ExternalPointerTag tag) {
  return tag >= kFirstSharedTag && tag <= kLastSharedTag;
}

// True if the external pointer may live in a read-only object, in which case
// the table entry will be in the shared read-only segment of the external
// pointer table.
V8_INLINE static constexpr bool IsMaybeReadOnlyExternalPointerType(
    ExternalPointerTag tag) {
  return tag == kAccessorInfoGetterTag || tag == kAccessorInfoSetterTag ||
         tag == kFunctionTemplateInfoCallbackTag;
}

// Sanity checks.
#define CHECK_SHARED_EXTERNAL_POINTER_TAGS(Tag, ...) \
  static_assert(IsSharedExternalPointerType(Tag));
#define CHECK_NON_SHARED_EXTERNAL_POINTER_TAGS(Tag, ...) \
  static_assert(!IsSharedExternalPointerType(Tag));

SHARED_EXTERNAL_POINTER_TAGS(CHECK_SHARED_EXTERNAL_POINTER_TAGS)
PER_ISOLATE_EXTERNAL_POINTER_TAGS(CHECK_NON_SHARED_EXTERNAL_POINTER_TAGS)

#undef CHECK_NON_SHARED_EXTERNAL_POINTER_TAGS
#undef CHECK_SHARED_EXTERNAL_POINTER_TAGS

#undef SHARED_EXTERNAL_POINTER_TAGS
#undef EXTERNAL_POINTER_TAGS

//
// Indirect Pointers.
//
// When the sandbox is enabled, indirect pointers are used to reference
// HeapObjects that live outside of the sandbox (but are still managed by V8's
// garbage collector). When object A references an object B through an indirect
// pointer, object A will contain a IndirectPointerHandle, i.e. a shifted
// 32-bit index, which identifies an entry in a pointer table (either the
// trusted pointer table for TrustedObjects, or the code pointer table if it is
// a Code object). This table entry then contains the actual pointer to object
// B. Further, object B owns this pointer table entry, and it is responsible
// for updating the "self-pointer" in the entry when it is relocated in memory.
// This way, in contrast to "normal" pointers, indirect pointers never need to
// be tracked by the GC (i.e. there is no remembered set for them).
// These pointers do not exist when the sandbox is disabled.

// An IndirectPointerHandle represents a 32-bit index into a pointer table.
using IndirectPointerHandle = uint32_t;

// A null handle always references an entry that contains nullptr.
constexpr IndirectPointerHandle kNullIndirectPointerHandle = 0;

// When the sandbox is enabled, indirect pointers are used to implement:
// - TrustedPointers: an indirect pointer using the trusted pointer table (TPT)
//   and referencing a TrustedObject in one of the trusted heap spaces.
// - CodePointers, an indirect pointer using the code pointer table (CPT) and
//   referencing a Code object together with its instruction stream.

//
// Trusted Pointers.
//
// A pointer to a TrustedObject.
// When the sandbox is enabled, these are indirect pointers using the trusted
// pointer table (TPT). They are used to reference trusted objects (located in
// one of V8's trusted heap spaces, outside of the sandbox) from inside the
// sandbox in a memory-safe way. When the sandbox is disabled, these are
// regular tagged pointers.
using TrustedPointerHandle = IndirectPointerHandle;

// The size of the virtual memory reservation for the trusted pointer table.
// As with the external pointer table, a maximum table size in combination with
// shifted indices allows omitting bounds checks.
constexpr size_t kTrustedPointerTableReservationSize = 64 * MB;

// The trusted pointer handles are stores shifted to the left by this amount
// to guarantee that they are smaller than the maximum table size.
constexpr uint32_t kTrustedPointerHandleShift = 9;

// A null handle always references an entry that contains nullptr.
constexpr TrustedPointerHandle kNullTrustedPointerHandle =
    kNullIndirectPointerHandle;

// The maximum number of entries in an trusted pointer table.
constexpr int kTrustedPointerTableEntrySize = 8;
constexpr int kTrustedPointerTableEntrySizeLog2 = 3;
constexpr size_t kMaxTrustedPointers =
    kTrustedPointerTableReservationSize / kTrustedPointerTableEntrySize;
static_assert((1 << (32 - kTrustedPointerHandleShift)) == kMaxTrustedPointers,
              "kTrustedPointerTableReservationSize and "
              "kTrustedPointerHandleShift don't match");

//
// Code Pointers.
//
// A pointer to a Code object.
// Essentially a specialized version of a trusted pointer that (when the
// sandbox is enabled) uses the code pointer table (CPT) instead of the TPT.
// Each entry in the CPT contains both a pointer to a Code object as well as a
// pointer to the Code's entrypoint. This allows calling/jumping into Code with
// one fewer memory access (compared to the case where the entrypoint pointer
// first needs to be loaded from the Code object). As such, a CodePointerHandle
// can be used both to obtain the referenced Code object and to directly load
// its entrypoint.
//
// When the sandbox is disabled, these are regular tagged pointers.
using CodePointerHandle = IndirectPointerHandle;

// The size of the virtual memory reservation for the code pointer table.
// As with the other tables, a maximum table size in combination with shifted
// indices allows omitting bounds checks.
constexpr size_t kCodePointerTableReservationSize = 16 * MB;

// Code pointer handles are shifted by a different amount than indirect pointer
// handles as the tables have a different maximum size.
constexpr uint32_t kCodePointerHandleShift = 12;

// A null handle always references an entry that contains nullptr.
constexpr CodePointerHandle kNullCodePointerHandle = kNullIndirectPointerHandle;

// It can sometimes be necessary to distinguish a code pointer handle from a
// trusted pointer handle. A typical example would be a union trusted pointer
// field that can refer to both Code objects and other trusted objects. To
// support these use-cases, we use a simple marking scheme where some of the
// low bits of a code pointer handle are set, while they will be unset on a
// trusted pointer handle. This way, the correct table to resolve the handle
// can be determined even in the absence of a type tag.
constexpr uint32_t kCodePointerHandleMarker = 0x1;
static_assert(kCodePointerHandleShift > 0);
static_assert(kTrustedPointerHandleShift > 0);

// The maximum number of entries in a code pointer table.
constexpr int kCodePointerTableEntrySize = 16;
constexpr int kCodePointerTableEntrySizeLog2 = 4;
constexpr size_t kMaxCodePointers =
    kCodePointerTableReservationSize / kCodePointerTableEntrySize;
static_assert(
    (1 << (32 - kCodePointerHandleShift)) == kMaxCodePointers,
    "kCodePointerTableReservationSize and kCodePointerHandleShift don't match");

constexpr int kCodePointerTableEntryEntrypointOffset = 0;
constexpr int kCodePointerTableEntryCodeObjectOffset = 8;

// Constants that can be used to mark places that should be modified once
// certain types of objects are moved out of the sandbox and into trusted space.
constexpr bool kRuntimeGeneratedCodeObjectsLiveInTrustedSpace = true;
constexpr bool kBuiltinCodeObjectsLiveInTrustedSpace = false;
constexpr bool kAllCodeObjectsLiveInTrustedSpace =
    kRuntimeGeneratedCodeObjectsLiveInTrustedSpace &&
    kBuiltinCodeObjectsLiveInTrustedSpace;

// {obj} must be the raw tagged pointer representation of a HeapObject
// that's guaranteed to never be in ReadOnlySpace.
V8_EXPORT internal::Isolate* IsolateFromNeverReadOnlySpaceObject(Address obj);

// Returns if we need to throw when an error occurs. This infers the language
// mode based on the current context and the closure. This returns true if the
// language mode is strict.
V8_EXPORT bool ShouldThrowOnError(internal::Isolate* isolate);
/**
 * This class exports constants and functionality from within v8 that
 * is necessary to implement inline functions in the v8 api.  Don't
 * depend on functions and constants defined here.
 */
class Internals {
#ifdef V8_MAP_PACKING
  V8_INLINE static constexpr Address UnpackMapWord(Address mapword) {
    // TODO(wenyuzhao): Clear header metadata.
    return mapword ^ kMapWordXorMask;
  }
#endif

 public:
  // These values match non-compiler-dependent values defined within
  // the implementation of v8.
  static const int kHeapObjectMapOffset = 0;
  static const int kMapInstanceTypeOffset = 1 * kApiTaggedSize + kApiInt32Size;
  static const int kStringResourceOffset =
      1 * kApiTaggedSize + 2 * kApiInt32Size;

  static const int kOddballKindOffset = 4 * kApiTaggedSize + kApiDoubleSize;
  static const int kJSObjectHeaderSize = 3 * kApiTaggedSize;
  static const int kFixedArrayHeaderSize = 2 * kApiTaggedSize;
  static const int kEmbedderDataArrayHeaderSize = 2 * kApiTaggedSize;
  static const int kEmbedderDataSlotSize = kApiSystemPointerSize;
#ifdef V8_ENABLE_SANDBOX
  static const int kEmbedderDataSlotExternalPointerOffset = kApiTaggedSize;
#else
  static const int kEmbedderDataSlotExternalPointerOffset = 0;
#endif
  static const int kNativeContextEmbedderDataOffset = 6 * kApiTaggedSize;
  static const int kStringRepresentationAndEncodingMask = 0x0f;
  static const int kStringEncodingMask = 0x8;
  static const int kExternalTwoByteRepresentationTag = 0x02;
  static const int kExternalOneByteRepresentationTag = 0x0a;

  static const uint32_t kNumIsolateDataSlots = 4;
  static const int kStackGuardSize = 8 * kApiSystemPointerSize;
  static const int kNumberOfBooleanFlags = 6;
  static const int kErrorMessageParamSize = 1;
  static const int kTablesAlignmentPaddingSize = 1;
  static const int kBuiltinTier0EntryTableSize = 7 * kApiSystemPointerSize;
  static const int kBuiltinTier0TableSize = 7 * kApiSystemPointerSize;
  static const int kLinearAllocationAreaSize = 3 * kApiSystemPointerSize;
  static const int kThreadLocalTopSize = 30 * kApiSystemPointerSize;
  static const int kHandleScopeDataSize =
      2 * kApiSystemPointerSize + 2 * kApiInt32Size;

  // ExternalPointerTable and TrustedPointerTable layout guarantees.
  static const int kExternalPointerTableBasePointerOffset = 0;
  static const int kExternalPointerTableSize = 2 * kApiSystemPointerSize;
  static const int kTrustedPointerTableSize = 2 * kApiSystemPointerSize;
  static const int kTrustedPointerTableBasePointerOffset = 0;

  // IsolateData layout guarantees.
  static const int kIsolateCageBaseOffset = 0;
  static const int kIsolateStackGuardOffset =
      kIsolateCageBaseOffset + kApiSystemPointerSize;
  static const int kVariousBooleanFlagsOffset =
      kIsolateStackGuardOffset + kStackGuardSize;
  static const int kErrorMessageParamOffset =
      kVariousBooleanFlagsOffset + kNumberOfBooleanFlags;
  static const int kBuiltinTier0EntryTableOffset = kErrorMessageParamOffset +
                                                   kErrorMessageParamSize +
                                                   kTablesAlignmentPaddingSize;
  static const int kBuiltinTier0TableOffset =
      kBuiltinTier0EntryTableOffset + kBuiltinTier0EntryTableSize;
  static const int kNewAllocationInfoOffset =
      kBuiltinTier0TableOffset + kBuiltinTier0TableSize;
  static const int kOldAllocationInfoOffset =
      kNewAllocationInfoOffset + kLinearAllocationAreaSize;

  static const int kFastCCallAlignmentPaddingSize =
      kApiSystemPointerSize == 8 ? 0 : kApiSystemPointerSize;
  static const int kIsolateFastCCallCallerFpOffset =
      kOldAllocationInfoOffset + kLinearAllocationAreaSize +
      kFastCCallAlignmentPaddingSize;
  static const int kIsolateFastCCallCallerPcOffset =
      kIsolateFastCCallCallerFpOffset + kApiSystemPointerSize;
  static const int kIsolateFastApiCallTargetOffset =
      kIsolateFastCCallCallerPcOffset + kApiSystemPointerSize;
  static const int kIsolateLongTaskStatsCounterOffset =
      kIsolateFastApiCallTargetOffset + kApiSystemPointerSize;
  static const int kIsolateThreadLocalTopOffset =
      kIsolateLongTaskStatsCounterOffset + kApiSizetSize;
  static const int kIsolateHandleScopeDataOffset =
      kIsolateThreadLocalTopOffset + kThreadLocalTopSize;
  static const int kIsolateEmbedderDataOffset =
      kIsolateHandleScopeDataOffset + kHandleScopeDataSize;
#ifdef V8_COMPRESS_POINTERS
  static const int kIsolateExternalPointerTableOffset =
      kIsolateEmbedderDataOffset + kNumIsolateDataSlots * kApiSystemPointerSize;
  static const int kIsolateSharedExternalPointerTableAddressOffset =
      kIsolateExternalPointerTableOffset + kExternalPointerTableSize;
#ifdef V8_ENABLE_SANDBOX
  static const int kIsolateTrustedCageBaseOffset =
      kIsolateSharedExternalPointerTableAddressOffset + kApiSystemPointerSize;
  static const int kIsolateTrustedPointerTableOffset =
      kIsolateTrustedCageBaseOffset + kApiSystemPointerSize;
  static const int kIsolateApiCallbackThunkArgumentOffset =
      kIsolateTrustedPointerTableOffset + kTrustedPointerTableSize;
#else
  static const int kIsolateApiCallbackThunkArgumentOffset =
      kIsolateSharedExternalPointerTableAddressOffset + kApiSystemPointerSize;
#endif  // V8_ENABLE_SANDBOX
#else
  static const int kIsolateApiCallbackThunkArgumentOffset =
      kIsolateEmbedderDataOffset + kNumIsolateDataSlots * kApiSystemPointerSize;
#endif  // V8_COMPRESS_POINTERS
  static const int kContinuationPreservedEmbedderDataOffset =
      kIsolateApiCallbackThunkArgumentOffset + kApiSystemPointerSize;

  static const int kWasm64OOBOffsetAlignmentPaddingSize = 0;
  static const int kWasm64OOBOffsetOffset =
      kContinuationPreservedEmbedderDataOffset + kApiSystemPointerSize +
      kWasm64OOBOffsetAlignmentPaddingSize;
  static const int kIsolateRootsOffset =
      kWasm64OOBOffsetOffset + sizeof(int64_t);

#if V8_STATIC_ROOTS_BOOL

// These constants are copied from static-roots.h and guarded by static asserts.
#define EXPORTED_STATIC_ROOTS_PTR_LIST(V) \
  V(UndefinedValue, 0x69)                 \
  V(NullValue, 0x85)                      \
  V(TrueValue, 0xc9)                      \
  V(FalseValue, 0xad)                     \
  V(EmptyString, 0xa1)                    \
  V(TheHoleValue, 0x719)

  using Tagged_t = uint32_t;
  struct StaticReadOnlyRoot {
#define DEF_ROOT(name, value) static constexpr Tagged_t k##name = value;
    EXPORTED_STATIC_ROOTS_PTR_LIST(DEF_ROOT)
#undef DEF_ROOT

    static constexpr Tagged_t kFirstStringMap = 0xe5;
    static constexpr Tagged_t kLastStringMap = 0x47d;

#define PLUSONE(...) +1
    static constexpr size_t kNumberOfExportedStaticRoots =
        2 + EXPORTED_STATIC_ROOTS_PTR_LIST(PLUSONE);
#undef PLUSONE
  };

#endif  // V8_STATIC_ROOTS_BOOL

  static const int kUndefinedValueRootIndex = 4;
  static const int kTheHoleValueRootIndex = 5;
  static const int kNullValueRootIndex = 6;
  static const int kTrueValueRootIndex = 7;
  static const int kFalseValueRootIndex = 8;
  static const int kEmptyStringRootIndex = 9;

  static const int kNodeClassIdOffset = 1 * kApiSystemPointerSize;
  static const int kNodeFlagsOffset = 1 * kApiSystemPointerSize + 3;
  static const int kNodeStateMask = 0x3;
  static const int kNodeStateIsWeakValue = 2;

  static const int kFirstNonstringType = 0x80;
  static const int kOddballType = 0x83;
  static const int kForeignType = 0xcc;
  static const int kJSSpecialApiObjectType = 0x410;
  static const int kJSObjectType = 0x421;
  static const int kFirstJSApiObjectType = 0x422;
  static const int kLastJSApiObjectType = 0x80A;
  // Defines a range [kFirstEmbedderJSApiObjectType, kJSApiObjectTypesCount]
  // of JSApiObject instance type values that an embedder can use.
  static const int kFirstEmbedderJSApiObjectType = 0;
  static const int kLastEmbedderJSApiObjectType =
      kLastJSApiObjectType - kFirstJSApiObjectType;

  static const int kUndefinedOddballKind = 4;
  static const int kNullOddballKind = 3;

  // Constants used by PropertyCallbackInfo to check if we should throw when an
  // error occurs.
  static const int kThrowOnError = 0;
  static const int kDontThrow = 1;
  static const int kInferShouldThrowMode = 2;

  // Soft limit for AdjustAmountofExternalAllocatedMemory. Trigger an
  // incremental GC once the external memory reaches this limit.
  static constexpr int kExternalAllocationSoftLimit = 64 * 1024 * 1024;

#ifdef V8_MAP_PACKING
  static const uintptr_t kMapWordMetadataMask = 0xffffULL << 48;
  // The lowest two bits of mapwords are always `0b10`
  static const uintptr_t kMapWordSignature = 0b10;
  // XORing a (non-compressed) map with this mask ensures that the two
  // low-order bits are 0b10. The 0 at the end makes this look like a Smi,
  // although real Smis have all lower 32 bits unset. We only rely on these
  // values passing as Smis in very few places.
  static const int kMapWordXorMask = 0b11;
#endif

  V8_EXPORT static void CheckInitializedImpl(v8::Isolate* isolate);
  V8_INLINE static void CheckInitialized(v8::Isolate* isolate) {
#ifdef V8_ENABLE_CHECKS
    CheckInitializedImpl(isolate);
#endif
  }

  V8_INLINE static constexpr bool HasHeapObjectTag(Address value) {
    return (value & kHeapObjectTagMask) == static_cast<Address>(kHeapObjectTag);
  }

  V8_INLINE static constexpr int SmiValue(Address value) {
    return PlatformSmiTagging::SmiToInt(value);
  }

  V8_INLINE static constexpr Address IntToSmi(int value) {
    return internal::IntToSmi(value);
  }

  V8_INLINE static constexpr bool IsValidSmi(intptr_t value) {
    return PlatformSmiTagging::IsValidSmi(value);
  }

#if V8_STATIC_ROOTS_BOOL
  V8_INLINE static bool is_identical(Address obj, Tagged_t constant) {
    return static_cast<Tagged_t>(obj) == constant;
  }

  V8_INLINE static bool CheckInstanceMapRange(Address obj, Tagged_t first_map,
                                              Tagged_t last_map) {
    auto map = ReadRawField<Tagged_t>(obj, kHeapObjectMapOffset);
#ifdef V8_MAP_PACKING
    map = UnpackMapWord(map);
#endif
    return map >= first_map && map <= last_map;
  }
#endif

  V8_INLINE static int GetInstanceType(Address obj) {
    Address map = ReadTaggedPointerField(obj, kHeapObjectMapOffset);
#ifdef V8_MAP_PACKING
    map = UnpackMapWord(map);
#endif
    return ReadRawField<uint16_t>(map, kMapInstanceTypeOffset);
  }

  V8_INLINE static Address LoadMap(Address obj) {
    if (!HasHeapObjectTag(obj)) return kNullAddress;
    Address map = ReadTaggedPointerField(obj, kHeapObjectMapOffset);
#ifdef V8_MAP_PACKING
    map = UnpackMapWord(map);
#endif
    return map;
  }

  V8_INLINE static int GetOddballKind(Address obj) {
    return SmiValue(ReadTaggedSignedField(obj, kOddballKindOffset));
  }

  V8_INLINE static bool IsExternalTwoByteString(int instance_type) {
    int representation = (instance_type & kStringRepresentationAndEncodingMask);
    return representation == kExternalTwoByteRepresentationTag;
  }

  V8_INLINE static constexpr bool CanHaveInternalField(int instance_type) {
    static_assert(kJSObjectType + 1 == kFirstJSApiObjectType);
    static_assert(kJSObjectType < kLastJSApiObjectType);
    static_assert(kFirstJSApiObjectType < kLastJSApiObjectType);
    // Check for IsJSObject() || IsJSSpecialApiObject() || IsJSApiObject()
    return instance_type == kJSSpecialApiObjectType ||
           // inlined version of base::IsInRange
           (static_cast<unsigned>(static_cast<unsigned>(instance_type) -
                                  static_cast<unsigned>(kJSObjectType)) <=
            static_cast<unsigned>(kLastJSApiObjectType - kJSObjectType));
  }

  V8_INLINE static uint8_t GetNodeFlag(Address* obj, int shift) {
    uint8_t* addr = reinterpret_cast<uint8_t*>(obj) + kNodeFlagsOffset;
    return *addr & static_cast<uint8_t>(1U << shift);
  }

  V8_INLINE static void UpdateNodeFlag(Address* obj, bool value, int shift) {
    uint8_t* addr = reinterpret_cast<uint8_t*>(obj) + kNodeFlagsOffset;
    uint8_t mask = static_cast<uint8_t>(1U << shift);
    *addr = static_cast<uint8_t>((*addr & ~mask) | (value << shift));
  }

  V8_INLINE static uint8_t GetNodeState(Address* obj) {
    uint8_t* addr = reinterpret_cast<uint8_t*>(obj) + kNodeFlagsOffset;
    return *addr & kNodeStateMask;
  }

  V8_INLINE static void UpdateNodeState(Address* obj, uint8_t value) {
    uint8_t* addr = reinterpret_cast<uint8_t*>(obj) + kNodeFlagsOffset;
    *addr = static_cast<uint8_t>((*addr & ~kNodeStateMask) | value);
  }

  V8_INLINE static void SetEmbedderData(v8::Isolate* isolate, uint32_t slot,
                                        void* data) {
    Address addr = reinterpret_cast<Address>(isolate) +
                   kIsolateEmbedderDataOffset + slot * kApiSystemPointerSize;
    *reinterpret_cast<void**>(addr) = data;
  }

  V8_INLINE static void* GetEmbedderData(const v8::Isolate* isolate,
                                         uint32_t slot) {
    Address addr = reinterpret_cast<Address>(isolate) +
                   kIsolateEmbedderDataOffset + slot * kApiSystemPointerSize;
    return *reinterpret_cast<void* const*>(addr);
  }

  V8_INLINE static void IncrementLongTasksStatsCounter(v8::Isolate* isolate) {
    Address addr =
        reinterpret_cast<Address>(isolate) + kIsolateLongTaskStatsCounterOffset;
    ++(*reinterpret_cast<size_t*>(addr));
  }

  V8_INLINE static Address* GetRootSlot(v8::Isolate* isolate, int index) {
    Address addr = reinterpret_cast<Address>(isolate) + kIsolateRootsOffset +
                   index * kApiSystemPointerSize;
    return reinterpret_cast<Address*>(addr);
  }

  V8_INLINE static Address GetRoot(v8::Isolate* isolate, int index) {
#if V8_STATIC_ROOTS_BOOL
    Address base = *reinterpret_cast<Address*>(
        reinterpret_cast<uintptr_t>(isolate) + kIsolateCageBaseOffset);
    switch (index) {
#define DECOMPRESS_ROOT(name, ...) \
  case k##name##RootIndex:         \
    return base + StaticReadOnlyRoot::k##name;
      EXPORTED_STATIC_ROOTS_PTR_LIST(DECOMPRESS_ROOT)
#undef DECOMPRESS_ROOT
#undef EXPORTED_STATIC_ROOTS_PTR_LIST
      default:
        break;
    }
#endif  // V8_STATIC_ROOTS_BOOL
    return *GetRootSlot(isolate, index);
  }

#ifdef V8_ENABLE_SANDBOX
  V8_INLINE static Address* GetExternalPointerTableBase(v8::Isolate* isolate) {
    Address addr = reinterpret_cast<Address>(isolate) +
                   kIsolateExternalPointerTableOffset +
                   kExternalPointerTableBasePointerOffset;
    return *reinterpret_cast<Address**>(addr);
  }

  V8_INLINE static Address* GetSharedExternalPointerTableBase(
      v8::Isolate* isolate) {
    Address addr = reinterpret_cast<Address>(isolate) +
                   kIsolateSharedExternalPointerTableAddressOffset;
    addr = *reinterpret_cast<Address*>(addr);
    addr += kExternalPointerTableBasePointerOffset;
    return *reinterpret_cast<Address**>(addr);
  }
#endif

  template <typename T>
  V8_INLINE static T ReadRawField(Address heap_object_ptr, int offset) {
    Address addr = heap_object_ptr + offset - kHeapObjectTag;
#ifdef V8_COMPRESS_POINTERS
    if (sizeof(T) > kApiTaggedSize) {
      // TODO(ishell, v8:8875): When pointer compression is enabled 8-byte size
      // fields (external pointers, doubles and BigInt data) are only
      // kTaggedSize aligned so we have to use unaligned pointer friendly way of
      // accessing them in order to avoid undefined behavior in C++ code.
      T r;
      memcpy(&r, reinterpret_cast<void*>(addr), sizeof(T));
      return r;
    }
#endif
    return *reinterpret_cast<const T*>(addr);
  }

  V8_INLINE static Address ReadTaggedPointerField(Address heap_object_ptr,
                                                  int offset) {
#ifdef V8_COMPRESS_POINTERS
    uint32_t value = ReadRawField<uint32_t>(heap_object_ptr, offset);
    Address base = GetPtrComprCageBaseFromOnHeapAddress(heap_object_ptr);
    return base + static_cast<Address>(static_cast<uintptr_t>(value));
#else
    return ReadRawField<Address>(heap_object_ptr, offset);
#endif
  }

  V8_INLINE static Address ReadTaggedSignedField(Address heap_object_ptr,
                                                 int offset) {
#ifdef V8_COMPRESS_POINTERS
    uint32_t value = ReadRawField<uint32_t>(heap_object_ptr, offset);
    return static_cast<Address>(static_cast<uintptr_t>(value));
#else
    return ReadRawField<Address>(heap_object_ptr, offset);
#endif
  }

  V8_INLINE static v8::Isolate* GetIsolateForSandbox(Address obj) {
#ifdef V8_ENABLE_SANDBOX
    return reinterpret_cast<v8::Isolate*>(
        internal::IsolateFromNeverReadOnlySpaceObject(obj));
#else
    // Not used in non-sandbox mode.
    return nullptr;
#endif
  }

  template <ExternalPointerTag tag>
  V8_INLINE static Address ReadExternalPointerField(v8::Isolate* isolate,
                                                    Address heap_object_ptr,
                                                    int offset) {
#ifdef V8_ENABLE_SANDBOX
    static_assert(tag != kExternalPointerNullTag);
    // See src/sandbox/external-pointer-table-inl.h. Logic duplicated here so
    // it can be inlined and doesn't require an additional call.
    Address* table = IsSharedExternalPointerType(tag)
                         ? GetSharedExternalPointerTableBase(isolate)
                         : GetExternalPointerTableBase(isolate);
    internal::ExternalPointerHandle handle =
        ReadRawField<ExternalPointerHandle>(heap_object_ptr, offset);
    uint32_t index = handle >> kExternalPointerIndexShift;
    std::atomic<Address>* ptr =
        reinterpret_cast<std::atomic<Address>*>(&table[index]);
    Address entry = std::atomic_load_explicit(ptr, std::memory_order_relaxed);
    return entry & ~tag;
#else
    return ReadRawField<Address>(heap_object_ptr, offset);
#endif  // V8_ENABLE_SANDBOX
  }

#ifdef V8_COMPRESS_POINTERS
  V8_INLINE static Address GetPtrComprCageBaseFromOnHeapAddress(Address addr) {
    return addr & -static_cast<intptr_t>(kPtrComprCageBaseAlignment);
  }

  V8_INLINE static uint32_t CompressTagged(Address value) {
    return static_cast<uint32_t>(value);
  }

  V8_INLINE static Address DecompressTaggedField(Address heap_object_ptr,
                                                 uint32_t value) {
    Address base = GetPtrComprCageBaseFromOnHeapAddress(heap_object_ptr);
    return base + static_cast<Address>(static_cast<uintptr_t>(value));
  }

#endif  // V8_COMPRESS_POINTERS
};

// Only perform cast check for types derived from v8::Data since
// other types do not implement the Cast method.
template <bool PerformCheck>
struct CastCheck {
  template <class T>
  static void Perform(T* data);
};

template <>
template <class T>
void CastCheck<true>::Perform(T* data) {
  T::Cast(data);
}

template <>
template <class T>
void CastCheck<false>::Perform(T* data) {}

template <class T>
V8_INLINE void PerformCastCheck(T* data) {
  CastCheck<std::is_base_of<Data, T>::value &&
            !std::is_same<Data, std::remove_cv_t<T>>::value>::Perform(data);
}

// A base class for backing stores, which is needed due to vagaries of
// how static casts work with std::shared_ptr.
class BackingStoreBase {};

// The maximum value in enum GarbageCollectionReason, defined in heap.h.
// This is needed for histograms sampling garbage collection reasons.
constexpr int kGarbageCollectionReasonMaxValue = 27;

// Base class for the address block allocator compatible with standard
// containers, which registers its allocated range as strong roots.
class V8_EXPORT StrongRootAllocatorBase {
 public:
  Heap* heap() const { return heap_; }

  bool operator==(const StrongRootAllocatorBase& other) const {
    return heap_ == other.heap_;
  }
  bool operator!=(const StrongRootAllocatorBase& other) const {
    return heap_ != other.heap_;
  }

 protected:
  explicit StrongRootAllocatorBase(Heap* heap) : heap_(heap) {}
  explicit StrongRootAllocatorBase(v8::Isolate* isolate);

  // Allocate/deallocate a range of n elements of type internal::Address.
  Address* allocate_impl(size_t n);
  void deallocate_impl(Address* p, size_t n) noexcept;

 private:
  Heap* heap_;
};

// The general version of this template behaves just as std::allocator, with
// the exception that the constructor takes the isolate as parameter. Only
// specialized versions, e.g., internal::StrongRootAllocator<internal::Address>
// and internal::StrongRootAllocator<v8::Local<T>> register the allocated range
// as strong roots.
template <typename T>
class StrongRootAllocator : public StrongRootAllocatorBase,
                            private std::allocator<T> {
 public:
  using value_type = T;

  explicit StrongRootAllocator(Heap* heap) : StrongRootAllocatorBase(heap) {}
  explicit StrongRootAllocator(v8::Isolate* isolate)
      : StrongRootAllocatorBase(isolate) {}
  template <typename U>
  StrongRootAllocator(const StrongRootAllocator<U>& other) noexcept
      : StrongRootAllocatorBase(other) {}

  using std::allocator<T>::allocate;
  using std::allocator<T>::deallocate;
};

// A class of iterators that wrap some different iterator type.
// If specified, ElementType is the type of element accessed by the wrapper
// iterator; in this case, the actual reference and pointer types of Iterator
// must be convertible to ElementType& and ElementType*, respectively.
template <typename Iterator, typename ElementType = void>
class WrappedIterator {
 public:
  static_assert(
      !std::is_void_v<ElementType> ||
      (std::is_convertible_v<typename std::iterator_traits<Iterator>::pointer,
                             ElementType*> &&
       std::is_convertible_v<typename std::iterator_traits<Iterator>::reference,
                             ElementType&>));

  using iterator_category =
      typename std::iterator_traits<Iterator>::iterator_category;
  using difference_type =
      typename std::iterator_traits<Iterator>::difference_type;
  using value_type =
      std::conditional_t<std::is_void_v<ElementType>,
                         typename std::iterator_traits<Iterator>::value_type,
                         ElementType>;
  using pointer =
      std::conditional_t<std::is_void_v<ElementType>,
                         typename std::iterator_traits<Iterator>::pointer,
                         ElementType*>;
  using reference =
      std::conditional_t<std::is_void_v<ElementType>,
                         typename std::iterator_traits<Iterator>::reference,
                         ElementType&>;

  constexpr WrappedIterator() noexcept : it_() {}
  constexpr explicit WrappedIterator(Iterator it) noexcept : it_(it) {}

  template <typename OtherIterator, typename OtherElementType,
            std::enable_if_t<std::is_convertible_v<OtherIterator, Iterator>,
                             bool> = true>
  constexpr WrappedIterator(
      const WrappedIterator<OtherIterator, OtherElementType>& it) noexcept
      : it_(it.base()) {}

  constexpr reference operator*() const noexcept { return *it_; }
  constexpr pointer operator->() const noexcept { return it_.operator->(); }

  constexpr WrappedIterator& operator++() noexcept {
    ++it_;
    return *this;
  }
  constexpr WrappedIterator operator++(int) noexcept {
    WrappedIterator result(*this);
    ++(*this);
    return result;
  }

  constexpr WrappedIterator& operator--() noexcept {
    --it_;
    return *this;
  }
  constexpr WrappedIterator operator--(int) noexcept {
    WrappedIterator result(*this);
    --(*this);
    return result;
  }
  constexpr WrappedIterator operator+(difference_type n) const noexcept {
    WrappedIterator result(*this);
    result += n;
    return result;
  }
  constexpr WrappedIterator& operator+=(difference_type n) noexcept {
    it_ += n;
    return *this;
  }
  constexpr WrappedIterator operator-(difference_type n) const noexcept {
    return *this + (-n);
  }
  constexpr WrappedIterator& operator-=(difference_type n) noexcept {
    *this += -n;
    return *this;
  }
  constexpr reference operator[](difference_type n) const noexcept {
    return it_[n];
  }

  constexpr Iterator base() const noexcept { return it_; }

 private:
  template <typename OtherIterator, typename OtherElementType>
  friend class WrappedIterator;

 private:
  Iterator it_;
};

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator==(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return x.base() == y.base();
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator<(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return x.base() < y.base();
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator!=(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return !(x == y);
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator>(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return y < x;
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator>=(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return !(x < y);
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr bool operator<=(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept {
  return !(y < x);
}

template <typename Iterator, typename ElementType, typename OtherIterator,
          typename OtherElementType>
constexpr auto operator-(
    const WrappedIterator<Iterator, ElementType>& x,
    const WrappedIterator<OtherIterator, OtherElementType>& y) noexcept
    -> decltype(x.base() - y.base()) {
  return x.base() - y.base();
}

template <typename Iterator, typename ElementType>
constexpr WrappedIterator<Iterator> operator+(
    typename WrappedIterator<Iterator, ElementType>::difference_type n,
    const WrappedIterator<Iterator, ElementType>& x) noexcept {
  x += n;
  return x;
}

// Helper functions about values contained in handles.
// A value is either an indirect pointer or a direct pointer, depending on
// whether direct local support is enabled.
class ValueHelper final {
 public:
#ifdef V8_ENABLE_DIRECT_LOCAL
  static constexpr Address kTaggedNullAddress = 1;
  static constexpr Address kEmpty = kTaggedNullAddress;
#else
  static constexpr Address kEmpty = kNullAddress;
#endif  // V8_ENABLE_DIRECT_LOCAL

  template <typename T>
  V8_INLINE static bool IsEmpty(T* value) {
    return reinterpret_cast<Address>(value) == kEmpty;
  }

  // Returns a handle's "value" for all kinds of abstract handles. For Local,
  // it is equivalent to `*handle`. The variadic parameters support handle
  // types with extra type parameters, like `Persistent<T, M>`.
  template <template <typename T, typename... Ms> typename H, typename T,
            typename... Ms>
  V8_INLINE static T* HandleAsValue(const H<T, Ms...>& handle) {
    return handle.template value<T>();
  }

#ifdef V8_ENABLE_DIRECT_LOCAL

  template <typename T>
  V8_INLINE static Address ValueAsAddress(const T* value) {
    return reinterpret_cast<Address>(value);
  }

  template <typename T, bool check_null = true, typename S>
  V8_INLINE static T* SlotAsValue(S* slot) {
    if (check_null && slot == nullptr) {
      return reinterpret_cast<T*>(kTaggedNullAddress);
    }
    return *reinterpret_cast<T**>(slot);
  }

#else  // !V8_ENABLE_DIRECT_LOCAL

  template <typename T>
  V8_INLINE static Address ValueAsAddress(const T* value) {
    return *reinterpret_cast<const Address*>(value);
  }

  template <typename T, bool check_null = true, typename S>
  V8_INLINE static T* SlotAsValue(S* slot) {
    return reinterpret_cast<T*>(slot);
  }

#endif  // V8_ENABLE_DIRECT_LOCAL
};

/**
 * Helper functions about handles.
 */
class HandleHelper final {
 public:
  /**
   * Checks whether two handles are equal.
   * They are equal iff they are both empty or they are both non-empty and the
   * objects to which they refer are physically equal.
   *
   * If both handles refer to JS objects, this is the same as strict equality.
   * For primitives, such as numbers or strings, a `false` return value does not
   * indicate that the values aren't equal in the JavaScript sense.
   * Use `Value::StrictEquals()` to check primitives for equality.
   */
  template <typename T1, typename T2>
  V8_INLINE static bool EqualHandles(const T1& lhs, const T2& rhs) {
    if (lhs.IsEmpty()) return rhs.IsEmpty();
    if (rhs.IsEmpty()) return false;
    return lhs.ptr() == rhs.ptr();
  }

  static V8_EXPORT bool IsOnStack(const void* ptr);
  static V8_EXPORT void VerifyOnStack(const void* ptr);
  static V8_EXPORT void VerifyOnMainThread();
};

V8_EXPORT void VerifyHandleIsNonEmpty(bool is_empty);

}  // namespace internal
}  // namespace v8

#endif  // INCLUDE_V8_INTERNAL_H_
