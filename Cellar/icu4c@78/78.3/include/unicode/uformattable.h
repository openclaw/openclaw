// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
* Copyright (C) 2013-2014, International Business Machines Corporation and others.
* All Rights Reserved.
********************************************************************************
*
* File UFORMATTABLE.H
*
* Modification History:
*
*   Date        Name        Description
*   2013 Jun 7  srl         New
********************************************************************************
*/

/**
 * \file
 * \brief C API: UFormattable is a thin wrapper for primitive types used for formatting and parsing.
 *
 * This is a C interface to the icu::Formattable class. Static functions on this class convert
 * to and from this interface (via reinterpret_cast).  Note that Formattables (and thus UFormattables)
 * are mutable, and many operations (even getters) may actually modify the internal state. For this
 * reason, UFormattables are not thread safe, and should not be shared between threads.
 *
 * See {@link unum_parseToUFormattable} for example code.
 */

#ifndef UFORMATTABLE_H
#define UFORMATTABLE_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * Enum designating the type of a UFormattable instance.
 * Practically, this indicates which of the getters would return without conversion
 * or error.
 * @see icu::Formattable::Type
 * @stable ICU 52
 */
typedef enum UFormattableType {
  UFMT_DATE = 0, /**< ufmt_getDate() will return without conversion. @see ufmt_getDate*/
  UFMT_DOUBLE,   /**< ufmt_getDouble() will return without conversion.  @see ufmt_getDouble*/
  UFMT_LONG,     /**< ufmt_getLong() will return without conversion. @see ufmt_getLong */
  UFMT_STRING,   /**< ufmt_getUChars() will return without conversion.  @see ufmt_getUChars*/
  UFMT_ARRAY,    /**< ufmt_countArray() and ufmt_getArray() will return the value.  @see ufmt_getArrayItemByIndex */
  UFMT_INT64,    /**< ufmt_getInt64() will return without conversion. @see ufmt_getInt64 */
  UFMT_OBJECT,   /**< ufmt_getObject() will return without conversion.  @see ufmt_getObject*/
#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UFormattableType value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UFMT_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} UFormattableType;


/**
 * Opaque type representing various types of data which may be used for formatting
 * and parsing operations.
 * @see icu::Formattable
 * @stable ICU 52
 */
typedef void *UFormattable;

/**
 * Initialize a UFormattable, to type UNUM_LONG, value 0
 * may return error if memory allocation failed.
 * parameter status error code.
 * See {@link unum_parseToUFormattable} for example code.
 * @stable ICU 52
 * @return the new UFormattable
 * @see ufmt_close
 * @see icu::Formattable::Formattable()
 */
U_CAPI UFormattable* U_EXPORT2
ufmt_open(UErrorCode* status);

/**
 * Cleanup any additional memory allocated by this UFormattable.
 * @param fmt the formatter
 * @stable ICU 52
 * @see ufmt_open
 */
U_CAPI void U_EXPORT2
ufmt_close(UFormattable* fmt);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUFormattablePointer
 * "Smart pointer" class, closes a UFormattable via ufmt_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 52
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattablePointer, UFormattable, ufmt_close);

U_NAMESPACE_END

#endif

/**
 * Return the type of this object
 * @param fmt the UFormattable object
 * @param status status code - U_ILLEGAL_ARGUMENT_ERROR is returned if the UFormattable contains data not supported by
 * the API
 * @return the value as a UFormattableType
 * @see ufmt_isNumeric
 * @see icu::Formattable::getType() const
 * @stable ICU 52
 */
U_CAPI UFormattableType U_EXPORT2
ufmt_getType(const UFormattable* fmt, UErrorCode *status);

/**
 * Return whether the object is numeric.
 * @param fmt the UFormattable object
 * @return true if the object is a double, long, or int64 value, else false.
 * @see ufmt_getType
 * @see icu::Formattable::isNumeric() const
 * @stable ICU 52
 */
U_CAPI UBool U_EXPORT2
ufmt_isNumeric(const UFormattable* fmt);

/**
 * Gets the UDate value of this object.  If the type is not of type UFMT_DATE,
 * status is set to U_INVALID_FORMAT_ERROR and the return value is
 * undefined.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @return the value
 * @stable ICU 52
 * @see icu::Formattable::getDate(UErrorCode&) const
 */
U_CAPI UDate U_EXPORT2
ufmt_getDate(const UFormattable* fmt, UErrorCode *status);

/**
 * Gets the double value of this object. If the type is not a UFMT_DOUBLE, or
 * if there are additional significant digits than fit in a double type,
 * a conversion is performed with  possible loss of precision.
 * If the type is UFMT_OBJECT and the
 * object is a Measure, then the result of
 * getNumber().getDouble(status) is returned.  If this object is
 * neither a numeric type nor a Measure, then 0 is returned and
 * the status is set to U_INVALID_FORMAT_ERROR.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @return the value
 * @stable ICU 52
 * @see icu::Formattable::getDouble(UErrorCode&) const
 */
U_CAPI double U_EXPORT2
ufmt_getDouble(UFormattable* fmt, UErrorCode *status);

/**
 * Gets the long (int32_t) value of this object. If the magnitude is too
 * large to fit in a long, then the maximum or minimum long value,
 * as appropriate, is returned and the status is set to
 * U_INVALID_FORMAT_ERROR.  If this object is of type UFMT_INT64 and
 * it fits within a long, then no precision is lost.  If it is of
 * type kDouble or kDecimalNumber, then a conversion is performed, with
 * truncation of any fractional part.  If the type is UFMT_OBJECT and
 * the object is a Measure, then the result of
 * getNumber().getLong(status) is returned.  If this object is
 * neither a numeric type nor a Measure, then 0 is returned and
 * the status is set to U_INVALID_FORMAT_ERROR.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @return the value
 * @stable ICU 52
 * @see icu::Formattable::getLong(UErrorCode&) const
 */
U_CAPI int32_t U_EXPORT2
ufmt_getLong(UFormattable* fmt, UErrorCode *status);


/**
 * Gets the int64_t value of this object. If this object is of a numeric
 * type and the magnitude is too large to fit in an int64, then
 * the maximum or minimum int64 value, as appropriate, is returned
 * and the status is set to U_INVALID_FORMAT_ERROR.  If the
 * magnitude fits in an int64, then a casting conversion is
 * performed, with truncation of any fractional part.  If the type
 * is UFMT_OBJECT and the object is a Measure, then the result of
 * getNumber().getDouble(status) is returned.  If this object is
 * neither a numeric type nor a Measure, then 0 is returned and
 * the status is set to U_INVALID_FORMAT_ERROR.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @return the value
 * @stable ICU 52
 * @see icu::Formattable::getInt64(UErrorCode&) const
 */
U_CAPI int64_t U_EXPORT2
ufmt_getInt64(UFormattable* fmt, UErrorCode *status);

/**
 * Returns a pointer to the UObject contained within this
 * formattable (as a const void*), or NULL if this object
 * is not of type UFMT_OBJECT.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @return the value as a const void*. It is a polymorphic C++ object.
 * @stable ICU 52
 * @see icu::Formattable::getObject() const
 */
U_CAPI const void *U_EXPORT2
ufmt_getObject(const UFormattable* fmt, UErrorCode *status);

/**
 * Gets the string value of this object as a UChar string. If the type is not a
 * string, status is set to U_INVALID_FORMAT_ERROR and a NULL pointer is returned.
 * This function is not thread safe and may modify the UFormattable if need be to terminate the string.
 * The returned pointer is not valid if any other functions are called on this UFormattable, or if the UFormattable is closed.
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors
 * @param len if non null, contains the string length on return
 * @return the null terminated string value - must not be referenced after any other functions are called on this UFormattable.
 * @stable ICU 52
 * @see icu::Formattable::getString(UnicodeString&)const
 */
U_CAPI const UChar* U_EXPORT2
ufmt_getUChars(UFormattable* fmt, int32_t *len, UErrorCode *status);

/**
 * Get the number of array objects contained, if an array type UFMT_ARRAY
 * @param fmt the UFormattable object
 * @param status the error code - any conversion or format errors. U_ILLEGAL_ARGUMENT_ERROR if not an array type.
 * @return the number of array objects or undefined if not an array type
 * @stable ICU 52
 * @see ufmt_getArrayItemByIndex
 */
U_CAPI int32_t U_EXPORT2
ufmt_getArrayLength(const UFormattable* fmt, UErrorCode *status);

/**
 * Get the specified value from the array of UFormattables. Invalid if the object is not an array type UFMT_ARRAY
 * @param fmt the UFormattable object
 * @param n the number of the array to return (0 based).
 * @param status the error code - any conversion or format errors. Returns an error if n is out of bounds.
 * @return the nth array value, only valid while the containing UFormattable is valid. NULL if not an array.
 * @stable ICU 52
 * @see icu::Formattable::getArray(int32_t&, UErrorCode&) const
 */
U_CAPI UFormattable * U_EXPORT2
ufmt_getArrayItemByIndex(UFormattable* fmt, int32_t n, UErrorCode *status);

/**
 * Returns a numeric string representation of the number contained within this
 * formattable, or NULL if this object does not contain numeric type.
 * For values obtained by parsing, the returned decimal number retains
 * the full precision and range of the original input, unconstrained by
 * the limits of a double floating point or a 64 bit int.
 *
 * This function is not thread safe, and therefore is not declared const,
 * even though it is logically const.
 * The resulting buffer is owned by the UFormattable and is invalid if any other functions are
 * called on the UFormattable.
 *
 * Possible errors include U_MEMORY_ALLOCATION_ERROR, and
 * U_INVALID_STATE if the formattable object has not been set to
 * a numeric type.
 * @param fmt the UFormattable object
 * @param len if non-null, on exit contains the string length (not including the terminating null)
 * @param status the error code
 * @return the character buffer as a NULL terminated string, which is owned by the object and must not be accessed if any other functions are called on this object.
 * @stable ICU 52
 * @see icu::Formattable::getDecimalNumber(UErrorCode&)
 */
U_CAPI const char * U_EXPORT2
ufmt_getDecNumChars(UFormattable *fmt, int32_t *len, UErrorCode *status);

#endif

#endif
