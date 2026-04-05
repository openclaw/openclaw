// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_MEMORY_SPAN_H_
#define INCLUDE_V8_MEMORY_SPAN_H_

#include <stddef.h>

#include <array>
#include <iterator>
#include <type_traits>

#include "v8config.h"  // NOLINT(build/include_directory)

namespace v8 {

/**
 * Points to an unowned contiguous buffer holding a known number of elements.
 *
 * This is similar to std::span (under consideration for C++20), but does not
 * require advanced C++ support. In the (far) future, this may be replaced with
 * or aliased to std::span.
 *
 * To facilitate future migration, this class exposes a subset of the interface
 * implemented by std::span.
 */
template <typename T>
class V8_EXPORT MemorySpan {
 private:
  /** Some C++ machinery, brought from the future. */
  template <typename From, typename To>
  using is_array_convertible = std::is_convertible<From (*)[], To (*)[]>;
  template <typename From, typename To>
  static constexpr bool is_array_convertible_v =
      is_array_convertible<From, To>::value;

  template <typename It>
  using iter_reference_t = decltype(*std::declval<It&>());

  template <typename It, typename = void>
  struct is_compatible_iterator : std::false_type {};
  template <typename It>
  struct is_compatible_iterator<
      It,
      std::void_t<
          std::is_base_of<std::random_access_iterator_tag,
                          typename std::iterator_traits<It>::iterator_category>,
          is_array_convertible<std::remove_reference_t<iter_reference_t<It>>,
                               T>>> : std::true_type {};
  template <typename It>
  static constexpr bool is_compatible_iterator_v =
      is_compatible_iterator<It>::value;

  template <typename U>
  static constexpr U* to_address(U* p) noexcept {
    return p;
  }

  template <typename It,
            typename = std::void_t<decltype(std::declval<It&>().operator->())>>
  static constexpr auto to_address(It it) noexcept {
    return it.operator->();
  }

 public:
  /** The default constructor creates an empty span. */
  constexpr MemorySpan() = default;

  /** Constructor from nullptr and count, for backwards compatibility.
   * This is not compatible with C++20 std::span.
   */
  constexpr MemorySpan(std::nullptr_t, size_t) {}

  /** Constructor from "iterator" and count. */
  template <typename Iterator,
            std::enable_if_t<is_compatible_iterator_v<Iterator>, bool> = true>
  constexpr MemorySpan(Iterator first,
                       size_t count)  // NOLINT(runtime/explicit)
      : data_(to_address(first)), size_(count) {}

  /** Constructor from two "iterators". */
  template <typename Iterator,
            std::enable_if_t<is_compatible_iterator_v<Iterator> &&
                                 !std::is_convertible_v<Iterator, size_t>,
                             bool> = true>
  constexpr MemorySpan(Iterator first,
                       Iterator last)  // NOLINT(runtime/explicit)
      : data_(to_address(first)), size_(last - first) {}

  /** Implicit conversion from C-style array. */
  template <size_t N>
  constexpr MemorySpan(T (&a)[N]) noexcept  // NOLINT(runtime/explicit)
      : data_(a), size_(N) {}

  /** Implicit conversion from std::array. */
  template <typename U, size_t N,
            std::enable_if_t<is_array_convertible_v<U, T>, bool> = true>
  constexpr MemorySpan(
      std::array<U, N>& a) noexcept  // NOLINT(runtime/explicit)
      : data_(a.data()), size_{N} {}

  /** Implicit conversion from const std::array. */
  template <typename U, size_t N,
            std::enable_if_t<is_array_convertible_v<const U, T>, bool> = true>
  constexpr MemorySpan(
      const std::array<U, N>& a) noexcept  // NOLINT(runtime/explicit)
      : data_(a.data()), size_{N} {}

  /** Returns a pointer to the beginning of the buffer. */
  constexpr T* data() const { return data_; }
  /** Returns the number of elements that the buffer holds. */
  constexpr size_t size() const { return size_; }

  constexpr T& operator[](size_t i) const { return data_[i]; }

  /** Returns true if the buffer is empty. */
  constexpr bool empty() const { return size() == 0; }

  class Iterator {
   public:
    using iterator_category = std::forward_iterator_tag;
    using value_type = T;
    using difference_type = std::ptrdiff_t;
    using pointer = value_type*;
    using reference = value_type&;

    T& operator*() const { return *ptr_; }
    T* operator->() const { return ptr_; }

    bool operator==(Iterator other) const { return ptr_ == other.ptr_; }
    bool operator!=(Iterator other) const { return !(*this == other); }

    Iterator& operator++() {
      ++ptr_;
      return *this;
    }

    Iterator operator++(int) {
      Iterator temp(*this);
      ++(*this);
      return temp;
    }

   private:
    friend class MemorySpan<T>;

    explicit Iterator(T* ptr) : ptr_(ptr) {}

    T* ptr_ = nullptr;
  };

  Iterator begin() const { return Iterator(data_); }
  Iterator end() const { return Iterator(data_ + size_); }

 private:
  T* data_ = nullptr;
  size_t size_ = 0;
};

/**
 * Helper function template to create an array of fixed length, initialized by
 * the provided initializer list, without explicitly specifying the array size,
 * e.g.
 *
 *   auto arr = v8::to_array<Local<String>>({v8_str("one"), v8_str("two")});
 *
 * In the future, this may be replaced with or aliased to std::to_array (under
 * consideration for C++20).
 */

namespace detail {
template <class T, std::size_t N, std::size_t... I>
constexpr std::array<std::remove_cv_t<T>, N> to_array_lvalue_impl(
    T (&a)[N], std::index_sequence<I...>) {
  return {{a[I]...}};
}

template <class T, std::size_t N, std::size_t... I>
constexpr std::array<std::remove_cv_t<T>, N> to_array_rvalue_impl(
    T (&&a)[N], std::index_sequence<I...>) {
  return {{std::move(a[I])...}};
}
}  // namespace detail

template <class T, std::size_t N>
constexpr std::array<std::remove_cv_t<T>, N> to_array(T (&a)[N]) {
  return detail::to_array_lvalue_impl(a, std::make_index_sequence<N>{});
}

template <class T, std::size_t N>
constexpr std::array<std::remove_cv_t<T>, N> to_array(T (&&a)[N]) {
  return detail::to_array_rvalue_impl(std::move(a),
                                      std::make_index_sequence<N>{});
}

}  // namespace v8
#endif  // INCLUDE_V8_MEMORY_SPAN_H_
