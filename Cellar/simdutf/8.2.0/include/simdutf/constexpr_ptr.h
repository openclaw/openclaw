#ifndef SIMDUTF_CONSTEXPR_PTR_H
#define SIMDUTF_CONSTEXPR_PTR_H

#include <cstddef>

namespace simdutf {
namespace detail {
/**
 * The constexpr_ptr class is a workaround for reinterpret_cast not being
 * allowed during constant evaluation.
 */
template <typename to, typename from>
  requires(sizeof(to) == sizeof(from))
struct constexpr_ptr {
  const from *p;

  constexpr explicit constexpr_ptr(const from *ptr) noexcept : p(ptr) {}

  constexpr to operator*() const noexcept { return static_cast<to>(*p); }

  constexpr constexpr_ptr &operator++() noexcept {
    ++p;
    return *this;
  }

  constexpr constexpr_ptr operator++(int) noexcept {
    auto old = *this;
    ++p;
    return old;
  }

  constexpr constexpr_ptr &operator--() noexcept {
    --p;
    return *this;
  }

  constexpr constexpr_ptr operator--(int) noexcept {
    auto old = *this;
    --p;
    return old;
  }

  constexpr constexpr_ptr &operator+=(std::ptrdiff_t n) noexcept {
    p += n;
    return *this;
  }

  constexpr constexpr_ptr &operator-=(std::ptrdiff_t n) noexcept {
    p -= n;
    return *this;
  }

  constexpr constexpr_ptr operator+(std::ptrdiff_t n) const noexcept {
    return constexpr_ptr{p + n};
  }

  constexpr constexpr_ptr operator-(std::ptrdiff_t n) const noexcept {
    return constexpr_ptr{p - n};
  }

  constexpr std::ptrdiff_t operator-(const constexpr_ptr &o) const noexcept {
    return p - o.p;
  }

  constexpr to operator[](std::ptrdiff_t n) const noexcept {
    return static_cast<to>(*(p + n));
  }

  // to prevent compilation errors for memcpy, even if it is never
  // called during constant evaluation
  constexpr operator const void *() const noexcept { return p; }
};

template <typename to, typename from>
constexpr constexpr_ptr<to, from> constexpr_cast_ptr(from *p) noexcept {
  return constexpr_ptr<to, from>{p};
}

/**
 * helper type for constexpr_writeptr, so it is possible to
 * do "*ptr = val;"
 */
template <typename SrcType, typename TargetType>
struct constexpr_write_ptr_proxy {

  constexpr explicit constexpr_write_ptr_proxy(TargetType *raw) : p(raw) {}

  constexpr constexpr_write_ptr_proxy &operator=(SrcType v) {
    *p = static_cast<TargetType>(v);
    return *this;
  }

  TargetType *p;
};

/**
 * helper for working around reinterpret_cast not being allowed during constexpr
 * evaluation. will try to act as a SrcType* but actually write to the pointer
 * given in the constructor, which is of another type TargetType
 */
template <typename SrcType, typename TargetType> struct constexpr_write_ptr {
  constexpr explicit constexpr_write_ptr(TargetType *raw) : p(raw) {}

  constexpr constexpr_write_ptr_proxy<SrcType, TargetType> operator*() const {
    return constexpr_write_ptr_proxy<SrcType, TargetType>{p};
  }

  constexpr constexpr_write_ptr_proxy<SrcType, TargetType>
  operator[](std::ptrdiff_t n) const {
    return constexpr_write_ptr_proxy<SrcType, TargetType>{p + n};
  }

  constexpr constexpr_write_ptr &operator++() {
    ++p;
    return *this;
  }

  constexpr constexpr_write_ptr operator++(int) {
    constexpr_write_ptr old = *this;
    ++p;
    return old;
  }

  constexpr std::ptrdiff_t operator-(const constexpr_write_ptr &other) const {
    return p - other.p;
  }

  TargetType *p;
};

template <typename SrcType, typename TargetType>
constexpr auto constexpr_cast_writeptr(TargetType *raw) {
  return constexpr_write_ptr<SrcType, TargetType>{raw};
}

} // namespace detail
} // namespace simdutf
#endif
