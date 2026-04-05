// © 2017 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// char16ptr.h
// created: 2017feb28 Markus W. Scherer

#ifndef __CHAR16PTR_H__
#define __CHAR16PTR_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API

#include <cstddef>
#include <string_view>
#include <type_traits>

#endif

/**
 * \file
 * \brief C++ API: char16_t pointer wrappers with
 *        implicit conversion from bit-compatible raw pointer types.
 *        Also conversion functions from char16_t * to UChar * and OldUChar *.
 */

/**
 * \def U_ALIASING_BARRIER
 * Barrier for pointer anti-aliasing optimizations even across function boundaries.
 * @internal
 */
#ifdef U_ALIASING_BARRIER
    // Use the predefined value.
#elif (defined(__clang__) || defined(__GNUC__)) && U_PLATFORM != U_PF_BROWSER_NATIVE_CLIENT
#   define U_ALIASING_BARRIER(ptr) asm volatile("" : : "rm"(ptr) : "memory")
#elif defined(U_IN_DOXYGEN)
#   define U_ALIASING_BARRIER(ptr)
#endif

// ICU DLL-exported
#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * char16_t * wrapper with implicit conversion from distinct but bit-compatible pointer types.
 * @stable ICU 59
 */
class U_COMMON_API Char16Ptr final {
public:
    /**
     * Copies the pointer.
     * @param p pointer
     * @stable ICU 59
     */
    inline Char16Ptr(char16_t *p);
#if !U_CHAR16_IS_TYPEDEF
    /**
     * Converts the pointer to char16_t *.
     * @param p pointer to be converted
     * @stable ICU 59
     */
    inline Char16Ptr(uint16_t *p);
#endif
#if U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN)
    /**
     * Converts the pointer to char16_t *.
     * (Only defined if U_SIZEOF_WCHAR_T==2.)
     * @param p pointer to be converted
     * @stable ICU 59
     */
    inline Char16Ptr(wchar_t *p);
#endif
    /**
     * nullptr constructor.
     * @param p nullptr
     * @stable ICU 59
     */
    inline Char16Ptr(std::nullptr_t p);
    /**
     * Destructor.
     * @stable ICU 59
     */
    inline ~Char16Ptr();

    /**
     * Pointer access.
     * @return the wrapped pointer
     * @stable ICU 59
     */
    inline char16_t *get() const;
    /**
     * char16_t pointer access via type conversion (e.g., static_cast).
     * @return the wrapped pointer
     * @stable ICU 59
     */
    inline operator char16_t *() const { return get(); }

private:
    Char16Ptr() = delete;

#ifdef U_ALIASING_BARRIER
    template<typename T> static char16_t *cast(T *t) {
        U_ALIASING_BARRIER(t);
        return reinterpret_cast<char16_t *>(t);
    }

    char16_t *p_;
#else
    union {
        char16_t *cp;
        uint16_t *up;
        wchar_t *wp;
    } u_;
#endif
};

/// \cond
#ifdef U_ALIASING_BARRIER

Char16Ptr::Char16Ptr(char16_t *p) : p_(p) {}
#if !U_CHAR16_IS_TYPEDEF
Char16Ptr::Char16Ptr(uint16_t *p) : p_(cast(p)) {}
#endif
#if U_SIZEOF_WCHAR_T==2
Char16Ptr::Char16Ptr(wchar_t *p) : p_(cast(p)) {}
#endif
Char16Ptr::Char16Ptr(std::nullptr_t p) : p_(p) {}
Char16Ptr::~Char16Ptr() {
    U_ALIASING_BARRIER(p_);
}

char16_t *Char16Ptr::get() const { return p_; }

#else

Char16Ptr::Char16Ptr(char16_t *p) { u_.cp = p; }
#if !U_CHAR16_IS_TYPEDEF
Char16Ptr::Char16Ptr(uint16_t *p) { u_.up = p; }
#endif
#if U_SIZEOF_WCHAR_T==2
Char16Ptr::Char16Ptr(wchar_t *p) { u_.wp = p; }
#endif
Char16Ptr::Char16Ptr(std::nullptr_t p) { u_.cp = p; }
Char16Ptr::~Char16Ptr() {}

char16_t *Char16Ptr::get() const { return u_.cp; }

#endif
/// \endcond

/**
 * const char16_t * wrapper with implicit conversion from distinct but bit-compatible pointer types.
 * @stable ICU 59
 */
class U_COMMON_API ConstChar16Ptr final {
public:
    /**
     * Copies the pointer.
     * @param p pointer
     * @stable ICU 59
     */
    inline ConstChar16Ptr(const char16_t *p);
#if !U_CHAR16_IS_TYPEDEF
    /**
     * Converts the pointer to char16_t *.
     * @param p pointer to be converted
     * @stable ICU 59
     */
    inline ConstChar16Ptr(const uint16_t *p);
#endif
#if U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN)
    /**
     * Converts the pointer to char16_t *.
     * (Only defined if U_SIZEOF_WCHAR_T==2.)
     * @param p pointer to be converted
     * @stable ICU 59
     */
    inline ConstChar16Ptr(const wchar_t *p);
#endif
    /**
     * nullptr constructor.
     * @param p nullptr
     * @stable ICU 59
     */
    inline ConstChar16Ptr(const std::nullptr_t p);

    /**
     * Destructor.
     * @stable ICU 59
     */
    inline ~ConstChar16Ptr();

    /**
     * Pointer access.
     * @return the wrapped pointer
     * @stable ICU 59
     */
    inline const char16_t *get() const;
    /**
     * char16_t pointer access via type conversion (e.g., static_cast).
     * @return the wrapped pointer
     * @stable ICU 59
     */
    inline operator const char16_t *() const { return get(); }

private:
    ConstChar16Ptr() = delete;

#ifdef U_ALIASING_BARRIER
    template<typename T> static const char16_t *cast(const T *t) {
        U_ALIASING_BARRIER(t);
        return reinterpret_cast<const char16_t *>(t);
    }

    const char16_t *p_;
#else
    union {
        const char16_t *cp;
        const uint16_t *up;
        const wchar_t *wp;
    } u_;
#endif
};

/// \cond
#ifdef U_ALIASING_BARRIER

ConstChar16Ptr::ConstChar16Ptr(const char16_t *p) : p_(p) {}
#if !U_CHAR16_IS_TYPEDEF
ConstChar16Ptr::ConstChar16Ptr(const uint16_t *p) : p_(cast(p)) {}
#endif
#if U_SIZEOF_WCHAR_T==2
ConstChar16Ptr::ConstChar16Ptr(const wchar_t *p) : p_(cast(p)) {}
#endif
ConstChar16Ptr::ConstChar16Ptr(const std::nullptr_t p) : p_(p) {}
ConstChar16Ptr::~ConstChar16Ptr() {
    U_ALIASING_BARRIER(p_);
}

const char16_t *ConstChar16Ptr::get() const { return p_; }

#else

ConstChar16Ptr::ConstChar16Ptr(const char16_t *p) { u_.cp = p; }
#if !U_CHAR16_IS_TYPEDEF
ConstChar16Ptr::ConstChar16Ptr(const uint16_t *p) { u_.up = p; }
#endif
#if U_SIZEOF_WCHAR_T==2
ConstChar16Ptr::ConstChar16Ptr(const wchar_t *p) { u_.wp = p; }
#endif
ConstChar16Ptr::ConstChar16Ptr(const std::nullptr_t p) { u_.cp = p; }
ConstChar16Ptr::~ConstChar16Ptr() {}

const char16_t *ConstChar16Ptr::get() const { return u_.cp; }

#endif
/// \endcond

U_NAMESPACE_END

#endif  // U_SHOW_CPLUSPLUS_API

// Usable in header-only definitions
#if U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API

namespace U_ICU_NAMESPACE_OR_INTERNAL {

#ifndef U_FORCE_HIDE_INTERNAL_API
/** @internal */
template<typename T, typename = std::enable_if_t<std::is_same_v<T, UChar>>>
inline const char16_t *uprv_char16PtrFromUChar(const T *p) {
    if constexpr (std::is_same_v<UChar, char16_t>) {
        return p;
    } else {
#if U_SHOW_CPLUSPLUS_API
        return ConstChar16Ptr(p).get();
#else
#ifdef U_ALIASING_BARRIER
        U_ALIASING_BARRIER(p);
#endif
        return reinterpret_cast<const char16_t *>(p);
#endif
    }
}
#if !U_CHAR16_IS_TYPEDEF && (!defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 180000)
/** @internal */
inline const char16_t *uprv_char16PtrFromUint16(const uint16_t *p) {
#if U_SHOW_CPLUSPLUS_API
    return ConstChar16Ptr(p).get();
#else
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<const char16_t *>(p);
#endif
}
#endif
#if U_SIZEOF_WCHAR_T==2
/** @internal */
inline const char16_t *uprv_char16PtrFromWchar(const wchar_t *p) {
#if U_SHOW_CPLUSPLUS_API
    return ConstChar16Ptr(p).get();
#else
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<const char16_t *>(p);
#endif
}
#endif
#endif

/**
 * Converts from const char16_t * to const UChar *.
 * Includes an aliasing barrier if available.
 * @param p pointer
 * @return p as const UChar *
 * @stable ICU 59
 */
inline const UChar *toUCharPtr(const char16_t *p) {
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<const UChar *>(p);
}

/**
 * Converts from char16_t * to UChar *.
 * Includes an aliasing barrier if available.
 * @param p pointer
 * @return p as UChar *
 * @stable ICU 59
 */
inline UChar *toUCharPtr(char16_t *p) {
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<UChar *>(p);
}

/**
 * Converts from const char16_t * to const OldUChar *.
 * Includes an aliasing barrier if available.
 * @param p pointer
 * @return p as const OldUChar *
 * @stable ICU 59
 */
inline const OldUChar *toOldUCharPtr(const char16_t *p) {
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<const OldUChar *>(p);
}

/**
 * Converts from char16_t * to OldUChar *.
 * Includes an aliasing barrier if available.
 * @param p pointer
 * @return p as OldUChar *
 * @stable ICU 59
 */
inline OldUChar *toOldUCharPtr(char16_t *p) {
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return reinterpret_cast<OldUChar *>(p);
}

}  // U_ICU_NAMESPACE_OR_INTERNAL

#endif  // U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API

// ICU DLL-exported
#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

#ifndef U_FORCE_HIDE_INTERNAL_API
/**
 * Is T convertible to a std::u16string_view or some other 16-bit string view?
 * @internal
 */
template<typename T>
constexpr bool ConvertibleToU16StringView =
    std::is_convertible_v<T, std::u16string_view>
#if !U_CHAR16_IS_TYPEDEF && (!defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 180000)
    || std::is_convertible_v<T, std::basic_string_view<uint16_t>>
#endif
#if U_SIZEOF_WCHAR_T==2
    || std::is_convertible_v<T, std::wstring_view>
#endif
    ;

namespace internal {
/**
 * Pass-through overload.
 * @internal
 */
inline std::u16string_view toU16StringView(std::u16string_view sv) { return sv; }

#if !U_CHAR16_IS_TYPEDEF && (!defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 180000)
/**
 * Basically undefined behavior but sometimes necessary conversion
 * from std::basic_string_view<uint16_t> to std::u16string_view.
 * @internal
 */
inline std::u16string_view toU16StringView(std::basic_string_view<uint16_t> sv) {
    return { ConstChar16Ptr(sv.data()), sv.length() };
}
#endif

#if U_SIZEOF_WCHAR_T==2
/**
 * Basically undefined behavior but sometimes necessary conversion
 * from std::wstring_view to std::u16string_view.
 * @internal
 */
inline std::u16string_view toU16StringView(std::wstring_view sv) {
    return { ConstChar16Ptr(sv.data()), sv.length() };
}
#endif

/**
 * Pass-through overload.
 * @internal
 */
template <typename T,
          typename = typename std::enable_if_t<!std::is_pointer_v<std::remove_reference_t<T>>>>
inline std::u16string_view toU16StringViewNullable(const T& text) {
    return toU16StringView(text);
}

/**
 * In case of nullptr, return an empty view.
 * @internal
 */
template <typename T,
          typename = typename std::enable_if_t<std::is_pointer_v<std::remove_reference_t<T>>>,
          typename = void>
inline std::u16string_view toU16StringViewNullable(const T& text) {
    if (text == nullptr) return {};  // For backward compatibility.
    return toU16StringView(text);
}

}  // internal
#endif  // U_FORCE_HIDE_INTERNAL_API

U_NAMESPACE_END

#endif  // U_SHOW_CPLUSPLUS_API

#endif  // __CHAR16PTR_H__
