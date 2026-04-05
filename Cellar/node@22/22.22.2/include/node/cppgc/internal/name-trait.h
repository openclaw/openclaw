// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_NAME_TRAIT_H_
#define INCLUDE_CPPGC_INTERNAL_NAME_TRAIT_H_

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "cppgc/name-provider.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

#if CPPGC_SUPPORTS_OBJECT_NAMES && defined(__clang__)
#define CPPGC_SUPPORTS_COMPILE_TIME_TYPENAME 1

// Provides constexpr c-string storage for a name of fixed |Size| characters.
// Automatically appends terminating 0 byte.
template <size_t Size>
struct NameBuffer {
  char name[Size + 1]{};

  static constexpr NameBuffer FromCString(const char* str) {
    NameBuffer result;
    for (size_t i = 0; i < Size; ++i) result.name[i] = str[i];
    result.name[Size] = 0;
    return result;
  }
};

template <typename T>
const char* GetTypename() {
  static constexpr char kSelfPrefix[] =
      "const char *cppgc::internal::GetTypename() [T =";
  static_assert(__builtin_strncmp(__PRETTY_FUNCTION__, kSelfPrefix,
                                  sizeof(kSelfPrefix) - 1) == 0,
                "The prefix must match");
  static constexpr const char* kTypenameStart =
      __PRETTY_FUNCTION__ + sizeof(kSelfPrefix);
  static constexpr size_t kTypenameSize =
      __builtin_strlen(__PRETTY_FUNCTION__) - sizeof(kSelfPrefix) - 1;
  // NameBuffer is an indirection that is needed to make sure that only a
  // substring of __PRETTY_FUNCTION__ gets materialized in the binary.
  static constexpr auto buffer =
      NameBuffer<kTypenameSize>::FromCString(kTypenameStart);
  return buffer.name;
}

#else
#define CPPGC_SUPPORTS_COMPILE_TIME_TYPENAME 0
#endif

struct HeapObjectName {
  const char* value;
  bool name_was_hidden;
};

enum class HeapObjectNameForUnnamedObject : uint8_t {
  kUseClassNameIfSupported,
  kUseHiddenName,
};

class V8_EXPORT NameTraitBase {
 protected:
  static HeapObjectName GetNameFromTypeSignature(const char*);
};

// Trait that specifies how the garbage collector retrieves the name for a
// given object.
template <typename T>
class NameTrait final : public NameTraitBase {
 public:
  static constexpr bool HasNonHiddenName() {
#if CPPGC_SUPPORTS_COMPILE_TIME_TYPENAME
    return true;
#elif CPPGC_SUPPORTS_OBJECT_NAMES
    return true;
#else   // !CPPGC_SUPPORTS_OBJECT_NAMES
    return std::is_base_of<NameProvider, T>::value;
#endif  // !CPPGC_SUPPORTS_OBJECT_NAMES
  }

  static HeapObjectName GetName(
      const void* obj, HeapObjectNameForUnnamedObject name_retrieval_mode) {
    return GetNameFor(static_cast<const T*>(obj), name_retrieval_mode);
  }

 private:
  static HeapObjectName GetNameFor(const NameProvider* name_provider,
                                   HeapObjectNameForUnnamedObject) {
    // Objects inheriting from `NameProvider` are not considered unnamed as
    // users already provided a name for them.
    return {name_provider->GetHumanReadableName(), false};
  }

  static HeapObjectName GetNameFor(
      const void*, HeapObjectNameForUnnamedObject name_retrieval_mode) {
    if (name_retrieval_mode == HeapObjectNameForUnnamedObject::kUseHiddenName)
      return {NameProvider::kHiddenName, true};

#if CPPGC_SUPPORTS_COMPILE_TIME_TYPENAME
    return {GetTypename<T>(), false};
#elif CPPGC_SUPPORTS_OBJECT_NAMES

#if defined(V8_CC_GNU)
#define PRETTY_FUNCTION_VALUE __PRETTY_FUNCTION__
#elif defined(V8_CC_MSVC)
#define PRETTY_FUNCTION_VALUE __FUNCSIG__
#else
#define PRETTY_FUNCTION_VALUE nullptr
#endif

    static const HeapObjectName leaky_name =
        GetNameFromTypeSignature(PRETTY_FUNCTION_VALUE);
    return leaky_name;

#undef PRETTY_FUNCTION_VALUE

#else   // !CPPGC_SUPPORTS_OBJECT_NAMES
    return {NameProvider::kHiddenName, true};
#endif  // !CPPGC_SUPPORTS_OBJECT_NAMES
  }
};

using NameCallback = HeapObjectName (*)(const void*,
                                        HeapObjectNameForUnnamedObject);

}  // namespace internal
}  // namespace cppgc

#undef CPPGC_SUPPORTS_COMPILE_TIME_TYPENAME

#endif  // INCLUDE_CPPGC_INTERNAL_NAME_TRAIT_H_
