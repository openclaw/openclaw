// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_MAYBE_H_
#define INCLUDE_V8_MAYBE_H_

#include <type_traits>
#include <utility>

#include "v8-internal.h"  // NOLINT(build/include_directory)
#include "v8config.h"     // NOLINT(build/include_directory)

namespace v8 {

namespace api_internal {
// Called when ToChecked is called on an empty Maybe.
V8_EXPORT void FromJustIsNothing();
}  // namespace api_internal

/**
 * A simple Maybe type, representing an object which may or may not have a
 * value, see https://hackage.haskell.org/package/base/docs/Data-Maybe.html.
 *
 * If an API method returns a Maybe<>, the API method can potentially fail
 * either because an exception is thrown, or because an exception is pending,
 * e.g. because a previous API call threw an exception that hasn't been caught
 * yet, or because a TerminateExecution exception was thrown. In that case, a
 * "Nothing" value is returned.
 */
template <class T>
class Maybe {
 public:
  V8_INLINE bool IsNothing() const { return !has_value_; }
  V8_INLINE bool IsJust() const { return has_value_; }

  /**
   * An alias for |FromJust|. Will crash if the Maybe<> is nothing.
   */
  V8_INLINE T ToChecked() const { return FromJust(); }

  /**
   * Short-hand for ToChecked(), which doesn't return a value. To be used, where
   * the actual value of the Maybe is not needed like Object::Set.
   */
  V8_INLINE void Check() const {
    if (V8_UNLIKELY(!IsJust())) api_internal::FromJustIsNothing();
  }

  /**
   * Converts this Maybe<> to a value of type T. If this Maybe<> is
   * nothing (empty), |false| is returned and |out| is left untouched.
   */
  V8_WARN_UNUSED_RESULT V8_INLINE bool To(T* out) const {
    if (V8_LIKELY(IsJust())) *out = value_;
    return IsJust();
  }

  /**
   * Converts this Maybe<> to a value of type T. If this Maybe<> is
   * nothing (empty), V8 will crash the process.
   */
  V8_INLINE T FromJust() const& {
    if (V8_UNLIKELY(!IsJust())) api_internal::FromJustIsNothing();
    return value_;
  }

  /**
   * Converts this Maybe<> to a value of type T. If this Maybe<> is
   * nothing (empty), V8 will crash the process.
   */
  V8_INLINE T FromJust() && {
    if (V8_UNLIKELY(!IsJust())) api_internal::FromJustIsNothing();
    return std::move(value_);
  }

  /**
   * Converts this Maybe<> to a value of type T, using a default value if this
   * Maybe<> is nothing (empty).
   */
  V8_INLINE T FromMaybe(const T& default_value) const {
    return has_value_ ? value_ : default_value;
  }

  V8_INLINE bool operator==(const Maybe& other) const {
    return (IsJust() == other.IsJust()) &&
           (!IsJust() || FromJust() == other.FromJust());
  }

  V8_INLINE bool operator!=(const Maybe& other) const {
    return !operator==(other);
  }

 private:
  Maybe() : has_value_(false) {}
  explicit Maybe(const T& t) : has_value_(true), value_(t) {}
  explicit Maybe(T&& t) : has_value_(true), value_(std::move(t)) {}

  bool has_value_;
  T value_;

  template <class U>
  friend Maybe<U> Nothing();
  template <class U>
  friend Maybe<U> Just(const U& u);
  template <class U, std::enable_if_t<!std::is_lvalue_reference_v<U>>*>
  friend Maybe<U> Just(U&& u);
};

template <class T>
inline Maybe<T> Nothing() {
  return Maybe<T>();
}

template <class T>
inline Maybe<T> Just(const T& t) {
  return Maybe<T>(t);
}

// Don't use forwarding references here but instead use two overloads.
// Forwarding references only work when type deduction takes place, which is not
// the case for callsites such as Just<Type>(t).
template <class T, std::enable_if_t<!std::is_lvalue_reference_v<T>>* = nullptr>
inline Maybe<T> Just(T&& t) {
  return Maybe<T>(std::move(t));
}

// A template specialization of Maybe<T> for the case of T = void.
template <>
class Maybe<void> {
 public:
  V8_INLINE bool IsNothing() const { return !is_valid_; }
  V8_INLINE bool IsJust() const { return is_valid_; }

  V8_INLINE bool operator==(const Maybe& other) const {
    return IsJust() == other.IsJust();
  }

  V8_INLINE bool operator!=(const Maybe& other) const {
    return !operator==(other);
  }

 private:
  struct JustTag {};

  Maybe() : is_valid_(false) {}
  explicit Maybe(JustTag) : is_valid_(true) {}

  bool is_valid_;

  template <class U>
  friend Maybe<U> Nothing();
  friend Maybe<void> JustVoid();
};

inline Maybe<void> JustVoid() { return Maybe<void>(Maybe<void>::JustTag()); }

}  // namespace v8

#endif  // INCLUDE_V8_MAYBE_H_
