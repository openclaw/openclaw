// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File FMTABLE.H
*
* Modification History:
*
*   Date        Name        Description
*   02/29/97    aliu        Creation.
********************************************************************************
*/
#ifndef FMTABLE_H
#define FMTABLE_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Formattable is a thin wrapper for primitive types used for formatting and parsing
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/unistr.h"
#include "unicode/stringpiece.h"
#include "unicode/uformattable.h"

U_NAMESPACE_BEGIN

class FixedString;

namespace number::impl {
class DecimalQuantity;
}

/**
 * Formattable objects can be passed to the Format class or
 * its subclasses for formatting.  Formattable is a thin wrapper
 * class which interconverts between the primitive numeric types
 * (double, long, etc.) as well as UDate and UnicodeString.
 *
 * <p>Internally, a Formattable object is a union of primitive types.
 * As such, it can only store one flavor of data at a time.  To
 * determine what flavor of data it contains, use the getType method.
 *
 * <p>As of ICU 3.0, Formattable may also wrap a UObject pointer,
 * which it owns.  This allows an instance of any ICU class to be
 * encapsulated in a Formattable.  For legacy reasons and for
 * efficiency, primitive numeric types are still stored directly
 * within a Formattable.
 *
 * <p>The Formattable class is not suitable for subclassing.
 *
 * <p>See UFormattable for a C wrapper.
 */
class U_I18N_API Formattable : public UObject {
public:
    /**
     * This enum is only used to let callers distinguish between
     * the Formattable(UDate) constructor and the Formattable(double)
     * constructor; the compiler cannot distinguish the signatures,
     * since UDate is currently typedefed to be either double or long.
     * If UDate is changed later to be a bonafide class
     * or struct, then we no longer need this enum.
     * @stable ICU 2.4
     */
    enum ISDATE { kIsDate };

    /**
     * Default constructor
     * @stable ICU 2.4
     */
    Formattable(); // Type kLong, value 0

    /**
     * Creates a Formattable object with a UDate instance.
     * @param d the UDate instance.
     * @param flag the flag to indicate this is a date. Always set it to kIsDate
     * @stable ICU 2.0
     */
    Formattable(UDate d, ISDATE flag);

    /**
     * Creates a Formattable object with a double number.
     * @param d the double number.
     * @stable ICU 2.0
     */
    Formattable(double d);

    /**
     * Creates a Formattable object with a long number.
     * @param l the long number.
     * @stable ICU 2.0
     */
    Formattable(int32_t l);

    /**
     * Creates a Formattable object with an int64_t number
     * @param ll the int64_t number.
     * @stable ICU 2.8
     */
    Formattable(int64_t ll);

#if !UCONFIG_NO_CONVERSION
    /**
     * Creates a Formattable object with a char string pointer.
     * Assumes that the char string is null terminated.
     * @param strToCopy the char string.
     * @stable ICU 2.0
     */
    Formattable(const char* strToCopy);
#endif

    /**
     * Creates a Formattable object of an appropriate numeric type from a
     * a decimal number in string form.  The Formattable will retain the
     * full precision of the input in decimal format, even when it exceeds
     * what can be represented by a double or int64_t.
     *
     * @param number  the unformatted (not localized) string representation
     *                     of the Decimal number.
     * @param status  the error code.  Possible errors include U_INVALID_FORMAT_ERROR
     *                if the format of the string does not conform to that of a
     *                decimal number.
     * @stable ICU 4.4
     */
    Formattable(StringPiece number, UErrorCode &status);

    /**
     * Creates a Formattable object with a UnicodeString object to copy from.
     * @param strToCopy the UnicodeString string.
     * @stable ICU 2.0
     */
    Formattable(const UnicodeString& strToCopy);

    /**
     * Creates a Formattable object with a UnicodeString object to adopt from.
     * @param strToAdopt the UnicodeString string.
     * @stable ICU 2.0
     */
    Formattable(UnicodeString* strToAdopt);

    /**
     * Creates a Formattable object with an array of Formattable objects.
     * @param arrayToCopy the Formattable object array.
     * @param count the array count.
     * @stable ICU 2.0
     */
    Formattable(const Formattable* arrayToCopy, int32_t count);

    /**
     * Creates a Formattable object that adopts the given UObject.
     * @param objectToAdopt the UObject to set this object to
     * @stable ICU 3.0
     */
    Formattable(UObject* objectToAdopt);

    /**
     * Copy constructor.
     * @stable ICU 2.0
     */
    Formattable(const Formattable&);

    /**
     * Assignment operator.
     * @param rhs   The Formattable object to copy into this object.
     * @stable ICU 2.0
     */
    Formattable&    operator=(const Formattable &rhs);

    /**
     * Equality comparison.
     * @param other    the object to be compared with.
     * @return        true if other are equal to this, false otherwise.
     * @stable ICU 2.0
     */
    bool           operator==(const Formattable &other) const;

    /**
     * Equality operator.
     * @param other    the object to be compared with.
     * @return        true if other are unequal to this, false otherwise.
     * @stable ICU 2.0
     */
    bool           operator!=(const Formattable& other) const
      { return !operator==(other); }

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    virtual         ~Formattable();

    /**
     * Clone this object.
     * Clones can be used concurrently in multiple threads.
     * If an error occurs, then nullptr is returned.
     * The caller must delete the clone.
     *
     * @return a clone of this object
     *
     * @see getDynamicClassID
     * @stable ICU 2.8
     */
    Formattable *clone() const;

    /**
     * Selector for flavor of data type contained within a
     * Formattable object.  Formattable is a union of several
     * different types, and at any time contains exactly one type.
     * @stable ICU 2.4
     */
    enum Type {
        /**
         * Selector indicating a UDate value.  Use getDate to retrieve
         * the value.
         * @stable ICU 2.4
         */
        kDate,

        /**
         * Selector indicating a double value.  Use getDouble to
         * retrieve the value.
         * @stable ICU 2.4
         */
        kDouble,

        /**
         * Selector indicating a 32-bit integer value.  Use getLong to
         * retrieve the value.
         * @stable ICU 2.4
         */
        kLong,

        /**
         * Selector indicating a UnicodeString value.  Use getString
         * to retrieve the value.
         * @stable ICU 2.4
         */
        kString,

        /**
         * Selector indicating an array of Formattables.  Use getArray
         * to retrieve the value.
         * @stable ICU 2.4
         */
        kArray,

        /**
         * Selector indicating a 64-bit integer value.  Use getInt64
         * to retrieve the value.
         * @stable ICU 2.8
         */
        kInt64,

        /**
         * Selector indicating a UObject value.  Use getObject to
         * retrieve the value.
         * @stable ICU 3.0
         */
        kObject
   };

    /**
     * Gets the data type of this Formattable object.
     * @return    the data type of this Formattable object.
     * @stable ICU 2.0
     */
    Type getType() const;

    /**
     * Returns true if the data type of this Formattable object
     * is kDouble, kLong, or kInt64
     * @return true if this is a pure numeric object
     * @stable ICU 3.0
     */
    UBool           isNumeric() const;

    /**
     * Gets the double value of this object. If this object is not of type
     * kDouble then the result is undefined.
     * @return    the double value of this object.
     * @stable ICU 2.0
     */
    double getDouble() const { return fValue.fDouble; }

    /**
     * Gets the double value of this object. If this object is of type
     * long, int64 or Decimal Number then a conversion is performed, with
     * possible loss of precision.  If the type is kObject and the
     * object is a Measure, then the result of
     * getNumber().getDouble(status) is returned.  If this object is
     * neither a numeric type nor a Measure, then 0 is returned and
     * the status is set to U_INVALID_FORMAT_ERROR.
     * @param status the error code
     * @return the double value of this object.
     * @stable ICU 3.0
     */
    double          getDouble(UErrorCode& status) const;

    /**
     * Gets the long value of this object. If this object is not of type
     * kLong then the result is undefined.
     * @return    the long value of this object.
     * @stable ICU 2.0
     */
    int32_t getLong() const { return static_cast<int32_t>(fValue.fInt64); }

    /**
     * Gets the long value of this object. If the magnitude is too
     * large to fit in a long, then the maximum or minimum long value,
     * as appropriate, is returned and the status is set to
     * U_INVALID_FORMAT_ERROR.  If this object is of type kInt64 and
     * it fits within a long, then no precision is lost.  If it is of
     * type kDouble, then a conversion is performed, with
     * truncation of any fractional part.  If the type is kObject and
     * the object is a Measure, then the result of
     * getNumber().getLong(status) is returned.  If this object is
     * neither a numeric type nor a Measure, then 0 is returned and
     * the status is set to U_INVALID_FORMAT_ERROR.
     * @param status the error code
     * @return    the long value of this object.
     * @stable ICU 3.0
     */
    int32_t         getLong(UErrorCode& status) const;

    /**
     * Gets the int64 value of this object. If this object is not of type
     * kInt64 then the result is undefined.
     * @return    the int64 value of this object.
     * @stable ICU 2.8
     */
    int64_t getInt64() const { return fValue.fInt64; }

    /**
     * Gets the int64 value of this object. If this object is of a numeric
     * type and the magnitude is too large to fit in an int64, then
     * the maximum or minimum int64 value, as appropriate, is returned
     * and the status is set to U_INVALID_FORMAT_ERROR.  If the
     * magnitude fits in an int64, then a casting conversion is
     * performed, with truncation of any fractional part.  If the type
     * is kObject and the object is a Measure, then the result of
     * getNumber().getDouble(status) is returned.  If this object is
     * neither a numeric type nor a Measure, then 0 is returned and
     * the status is set to U_INVALID_FORMAT_ERROR.
     * @param status the error code
     * @return    the int64 value of this object.
     * @stable ICU 3.0
     */
    int64_t         getInt64(UErrorCode& status) const;

    /**
     * Gets the Date value of this object. If this object is not of type
     * kDate then the result is undefined.
     * @return    the Date value of this object.
     * @stable ICU 2.0
     */
    UDate           getDate() const { return fValue.fDate; }

    /**
     * Gets the Date value of this object.  If the type is not a date,
     * status is set to U_INVALID_FORMAT_ERROR and the return value is
     * undefined.
     * @param status the error code.
     * @return    the Date value of this object.
     * @stable ICU 3.0
     */
     UDate          getDate(UErrorCode& status) const;

    /**
     * Gets the string value of this object. If this object is not of type
     * kString then the result is undefined.
     * @param result    Output param to receive the Date value of this object.
     * @return          A reference to 'result'.
     * @stable ICU 2.0
     */
    UnicodeString&  getString(UnicodeString& result) const
      { result=*fValue.fString; return result; }

    /**
     * Gets the string value of this object. If the type is not a
     * string, status is set to U_INVALID_FORMAT_ERROR and a bogus
     * string is returned.
     * @param result    Output param to receive the Date value of this object.
     * @param status    the error code.
     * @return          A reference to 'result'.
     * @stable ICU 3.0
     */
    UnicodeString&  getString(UnicodeString& result, UErrorCode& status) const;

    /**
     * Gets a const reference to the string value of this object. If
     * this object is not of type kString then the result is
     * undefined.
     * @return   a const reference to the string value of this object.
     * @stable ICU 2.0
     */
    inline const UnicodeString& getString() const;

    /**
     * Gets a const reference to the string value of this object.  If
     * the type is not a string, status is set to
     * U_INVALID_FORMAT_ERROR and the result is a bogus string.
     * @param status    the error code.
     * @return   a const reference to the string value of this object.
     * @stable ICU 3.0
     */
    const UnicodeString& getString(UErrorCode& status) const;

    /**
     * Gets a reference to the string value of this object. If this
     * object is not of type kString then the result is undefined.
     * @return   a reference to the string value of this object.
     * @stable ICU 2.0
     */
    inline UnicodeString& getString();

    /**
     * Gets a reference to the string value of this object. If the
     * type is not a string, status is set to U_INVALID_FORMAT_ERROR
     * and the result is a bogus string.
     * @param status    the error code.
     * @return   a reference to the string value of this object.
     * @stable ICU 3.0
     */
    UnicodeString& getString(UErrorCode& status);

    /**
     * Gets the array value and count of this object. If this object
     * is not of type kArray then the result is undefined.
     * @param count    fill-in with the count of this object.
     * @return         the array value of this object.
     * @stable ICU 2.0
     */
    const Formattable* getArray(int32_t& count) const
      { count=fValue.fArrayAndCount.fCount; return fValue.fArrayAndCount.fArray; }

    /**
     * Gets the array value and count of this object. If the type is
     * not an array, status is set to U_INVALID_FORMAT_ERROR, count is
     * set to 0, and the result is nullptr.
     * @param count    fill-in with the count of this object.
     * @param status the error code.
     * @return         the array value of this object.
     * @stable ICU 3.0
     */
    const Formattable* getArray(int32_t& count, UErrorCode& status) const;

    /**
     * Accesses the specified element in the array value of this
     * Formattable object. If this object is not of type kArray then
     * the result is undefined.
     * @param index the specified index.
     * @return the accessed element in the array.
     * @stable ICU 2.0
     */
    Formattable&    operator[](int32_t index) { return fValue.fArrayAndCount.fArray[index]; }

    /**
     * Returns a pointer to the UObject contained within this
     * formattable, or nullptr if this object does not contain a UObject.
     * @return a UObject pointer, or nullptr
     * @stable ICU 3.0
     */
    const UObject*  getObject() const;

    /**
     * Returns a numeric string representation of the number contained within this
     * formattable, or nullptr if this object does not contain numeric type.
     * For values obtained by parsing, the returned decimal number retains
     * the full precision and range of the original input, unconstrained by
     * the limits of a double floating point or a 64 bit int.
     *
     * This function is not thread safe, and therefore is not declared const,
     * even though it is logically const.
     *
     * Possible errors include U_MEMORY_ALLOCATION_ERROR, and
     * U_INVALID_STATE if the formattable object has not been set to
     * a numeric type.
     *
     * @param status the error code.
     * @return the unformatted string representation of a number.
     * @stable ICU 4.4
     */
    StringPiece getDecimalNumber(UErrorCode &status);

     /**
     * Sets the double value of this object and changes the type to
     * kDouble.
     * @param d    the new double value to be set.
     * @stable ICU 2.0
     */
    void            setDouble(double d);

    /**
     * Sets the long value of this object and changes the type to
     * kLong.
     * @param l    the new long value to be set.
     * @stable ICU 2.0
     */
    void            setLong(int32_t l);

    /**
     * Sets the int64 value of this object and changes the type to
     * kInt64.
     * @param ll    the new int64 value to be set.
     * @stable ICU 2.8
     */
    void            setInt64(int64_t ll);

    /**
     * Sets the Date value of this object and changes the type to
     * kDate.
     * @param d    the new Date value to be set.
     * @stable ICU 2.0
     */
    void            setDate(UDate d);

    /**
     * Sets the string value of this object and changes the type to
     * kString.
     * @param stringToCopy    the new string value to be set.
     * @stable ICU 2.0
     */
    void            setString(const UnicodeString& stringToCopy);

    /**
     * Sets the array value and count of this object and changes the
     * type to kArray.
     * @param array    the array value.
     * @param count    the number of array elements to be copied.
     * @stable ICU 2.0
     */
    void            setArray(const Formattable* array, int32_t count);

    /**
     * Sets and adopts the string value and count of this object and
     * changes the type to kArray.
     * @param stringToAdopt    the new string value to be adopted.
     * @stable ICU 2.0
     */
    void            adoptString(UnicodeString* stringToAdopt);

    /**
     * Sets and adopts the array value and count of this object and
     * changes the type to kArray.
     * @stable ICU 2.0
     */
    void            adoptArray(Formattable* array, int32_t count);

    /**
     * Sets and adopts the UObject value of this object and changes
     * the type to kObject.  After this call, the caller must not
     * delete the given object.
     * @param objectToAdopt the UObject value to be adopted
     * @stable ICU 3.0
     */
    void            adoptObject(UObject* objectToAdopt);

    /**
     * Sets the numeric value from a decimal number string, and changes
     * the type to to a numeric type appropriate for the number.
     * The syntax of the number is a "numeric string"
     * as defined in the Decimal Arithmetic Specification, available at
     * http://speleotrove.com/decimal
     * The full precision and range of the input number will be retained,
     * even when it exceeds what can be represented by a double or an int64.
     *
     * @param numberString  a string representation of the unformatted decimal number.
     * @param status        the error code.  Set to U_INVALID_FORMAT_ERROR if the
     *                      incoming string is not a valid decimal number.
     * @stable ICU 4.4
     */
    void             setDecimalNumber(StringPiece numberString,
                                      UErrorCode &status);

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.2
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.2
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Convert the UFormattable to a Formattable.  Internally, this is a reinterpret_cast.
     * @param fmt a valid UFormattable
     * @return the UFormattable as a Formattable object pointer.  This is an alias to the original
     * UFormattable, and so is only valid while the original argument remains in scope.
     * @stable ICU 52
     */
    static inline Formattable *fromUFormattable(UFormattable *fmt);

    /**
     * Convert the const UFormattable to a const Formattable.  Internally, this is a reinterpret_cast.
     * @param fmt a valid UFormattable
     * @return the UFormattable as a Formattable object pointer.  This is an alias to the original
     * UFormattable, and so is only valid while the original argument remains in scope.
     * @stable ICU 52
     */
    static inline const Formattable *fromUFormattable(const UFormattable *fmt);

    /**
     * Convert this object pointer to a UFormattable.
     * @return this object as a UFormattable pointer.   This is an alias to this object,
     * and so is only valid while this object remains in scope.
     * @stable ICU 52
     */
    inline UFormattable *toUFormattable();

    /**
     * Convert this object pointer to a UFormattable.
     * @return this object as a UFormattable pointer.   This is an alias to this object,
     * and so is only valid while this object remains in scope.
     * @stable ICU 52
     */
    inline const UFormattable *toUFormattable() const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Deprecated variant of getLong(UErrorCode&).
     * @param status the error code
     * @return the long value of this object.
     * @deprecated ICU 3.0 use getLong(UErrorCode&) instead
     */
    inline int32_t getLong(UErrorCode* status) const;
#endif  /* U_HIDE_DEPRECATED_API */

#ifndef U_HIDE_INTERNAL_API
    /**
     * Internal function, do not use.
     * TODO:  figure out how to make this be non-public.
     *        NumberFormat::format(Formattable, ...
     *        needs to get at the DecimalQuantity, if it exists, for
     *        big decimal formatting.
     *  @internal
     */
    number::impl::DecimalQuantity *getDecimalQuantity() const { return fDecimalQuantity;}

    /**
     * Export the value of this Formattable to a DecimalQuantity.
     * @internal
     */
    void populateDecimalQuantity(number::impl::DecimalQuantity& output, UErrorCode& status) const;

    /**
     *  Adopt, and set value from, a DecimalQuantity
     *     Internal Function, do not use.
     *  @param dq the DecimalQuantity to be adopted
     *  @internal
     */
    void adoptDecimalQuantity(number::impl::DecimalQuantity *dq);

    /**
     * Internal function to return the FixedString pointer.
     * @param status error code
     * @return pointer to the FixedString - may become invalid if the object is modified
     * @internal
     */
    FixedString *internalGetFixedString(UErrorCode &status);

#endif  /* U_HIDE_INTERNAL_API */

private:
    /**
     * Cleans up the memory for unwanted values.  For example, the adopted
     * string or array objects.
     */
    void dispose();

    /**
     * Common initialization, for use by constructors.
     */
    void            init();

    UnicodeString* getBogus() const;

    union {
        UObject*        fObject;
        UnicodeString*  fString;
        double          fDouble;
        int64_t         fInt64;
        UDate           fDate;
        struct {
          Formattable*  fArray;
          int32_t       fCount;
        }               fArrayAndCount;
    } fValue;

    FixedString* fDecimalStr;

    number::impl::DecimalQuantity *fDecimalQuantity;

    Type                fType;
    UnicodeString       fBogus; // Bogus string when it's needed.
};

inline UDate Formattable::getDate(UErrorCode& status) const {
    if (fType != kDate) {
        if (U_SUCCESS(status)) {
            status = U_INVALID_FORMAT_ERROR;
        }
        return 0;
    }
    return fValue.fDate;
}

inline const UnicodeString& Formattable::getString() const {
    return *fValue.fString;
}

inline UnicodeString& Formattable::getString() {
    return *fValue.fString;
}

#ifndef U_HIDE_DEPRECATED_API
inline int32_t Formattable::getLong(UErrorCode* status) const {
    return getLong(*status);
}
#endif  /* U_HIDE_DEPRECATED_API */

inline UFormattable* Formattable::toUFormattable() {
  return reinterpret_cast<UFormattable*>(this);
}

inline const UFormattable* Formattable::toUFormattable() const {
  return reinterpret_cast<const UFormattable*>(this);
}

inline Formattable* Formattable::fromUFormattable(UFormattable *fmt) {
  return reinterpret_cast<Formattable *>(fmt);
}

inline const Formattable* Formattable::fromUFormattable(const UFormattable *fmt) {
  return reinterpret_cast<const Formattable *>(fmt);
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif //_FMTABLE
//eof
