// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_NAME_PROVIDER_H_
#define INCLUDE_CPPGC_NAME_PROVIDER_H_

#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

/**
 * NameProvider allows for providing a human-readable name for garbage-collected
 * objects.
 *
 * There's two cases of names to distinguish:
 * a. Explicitly specified names via using NameProvider. Such names are always
 *    preserved in the system.
 * b. Internal names that Oilpan infers from a C++ type on the class hierarchy
 *    of the object. This is not necessarily the type of the actually
 *    instantiated object.
 *
 * Depending on the build configuration, Oilpan may hide names, i.e., represent
 * them with kHiddenName, of case b. to avoid exposing internal details.
 */
class V8_EXPORT NameProvider {
 public:
  /**
   * Name that is used when hiding internals.
   */
  static constexpr const char kHiddenName[] = "InternalNode";

  /**
   * Name that is used in case compiler support is missing for composing a name
   * from C++ types.
   */
  static constexpr const char kNoNameDeducible[] = "<No name>";

  /**
   * Indicating whether the build supports extracting C++ names as object names.
   *
   * @returns true if C++ names should be hidden and represented by kHiddenName.
   */
  static constexpr bool SupportsCppClassNamesAsObjectNames() {
#if CPPGC_SUPPORTS_OBJECT_NAMES
    return true;
#else   // !CPPGC_SUPPORTS_OBJECT_NAMES
    return false;
#endif  // !CPPGC_SUPPORTS_OBJECT_NAMES
  }

  virtual ~NameProvider() = default;

  /**
   * Specifies a name for the garbage-collected object. Such names will never
   * be hidden, as they are explicitly specified by the user of this API.
   *
   * @returns a human readable name for the object.
   */
  virtual const char* GetHumanReadableName() const = 0;
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_NAME_PROVIDER_H_
