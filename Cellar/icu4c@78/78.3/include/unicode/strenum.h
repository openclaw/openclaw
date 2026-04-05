// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2002-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*/

#ifndef STRENUM_H
#define STRENUM_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"
#include "unicode/unistr.h"

/**
 * \file 
 * \brief C++ API: String Enumeration
 */
 
U_NAMESPACE_BEGIN

/**
 * Base class for 'pure' C++ implementations of uenum api.  Adds a
 * method that returns the next UnicodeString since in C++ this can
 * be a common storage format for strings.
 *
 * <p>The model is that the enumeration is over strings maintained by
 * a 'service.'  At any point, the service might change, invalidating
 * the enumerator (though this is expected to be rare).  The iterator
 * returns an error if this has occurred.  Lack of the error is no
 * guarantee that the service didn't change immediately after the
 * call, so the returned string still might not be 'valid' on
 * subsequent use.</p>
 *
 * <p>Strings may take the form of const char*, const char16_t*, or const
 * UnicodeString*.  The type you get is determine by the variant of
 * 'next' that you call.  In general the StringEnumeration is
 * optimized for one of these types, but all StringEnumerations can
 * return all types.  Returned strings are each terminated with a NUL.
 * Depending on the service data, they might also include embedded NUL
 * characters, so API is provided to optionally return the true
 * length, counting the embedded NULs but not counting the terminating
 * NUL.</p>
 *
 * <p>The pointers returned by next, unext, and snext become invalid
 * upon any subsequent call to the enumeration's destructor, next,
 * unext, snext, or reset.</p>
 *
 * ICU 2.8 adds some default implementations and helper functions
 * for subclasses.
 *
 * @stable ICU 2.4 
 */
class U_COMMON_API StringEnumeration : public UObject { 
public:
    /**
     * Destructor.
     * @stable ICU 2.4
     */
    virtual ~StringEnumeration();

    /**
     * Clone this object, an instance of a subclass of StringEnumeration.
     * Clones can be used concurrently in multiple threads.
     * If a subclass does not implement clone(), or if an error occurs,
     * then nullptr is returned.
     * The caller must delete the clone.
     *
     * @return a clone of this object
     *
     * @see getDynamicClassID
     * @stable ICU 2.8
     */
    virtual StringEnumeration *clone() const;

    /**
     * <p>Return the number of elements that the iterator traverses.  If
     * the iterator is out of sync with its service, status is set to
     * U_ENUM_OUT_OF_SYNC_ERROR, and the return value is zero.</p>
     *
     * <p>The return value will not change except possibly as a result of
     * a subsequent call to reset, or if the iterator becomes out of sync.</p>
     *
     * <p>This is a convenience function. It can end up being very
     * expensive as all the items might have to be pre-fetched
     * (depending on the storage format of the data being
     * traversed).</p>
     *
     * @param status the error code.
     * @return number of elements in the iterator.
     *
     * @stable ICU 2.4 */
    virtual int32_t count(UErrorCode& status) const = 0;

    /**
     * <p>Returns the next element as a NUL-terminated char*.  If there
     * are no more elements, returns nullptr.  If the resultLength pointer
     * is not nullptr, the length of the string (not counting the
     * terminating NUL) is returned at that address.  If an error
     * status is returned, the value at resultLength is undefined.</p>
     *
     * <p>The returned pointer is owned by this iterator and must not be
     * deleted by the caller.  The pointer is valid until the next call
     * to next, unext, snext, reset, or the enumerator's destructor.</p>
     *
     * <p>If the iterator is out of sync with its service, status is set
     * to U_ENUM_OUT_OF_SYNC_ERROR and nullptr is returned.</p>
     *
     * <p>If the native service string is a char16_t* string, it is
     * converted to char* with the invariant converter.  If the
     * conversion fails (because a character cannot be converted) then
     * status is set to U_INVARIANT_CONVERSION_ERROR and the return
     * value is undefined (though not nullptr).</p>
     *
     * Starting with ICU 2.8, the default implementation calls snext()
     * and handles the conversion.
     * Either next() or snext() must be implemented differently by a subclass.
     *
     * @param status the error code.
     * @param resultLength a pointer to receive the length, can be nullptr.
     * @return a pointer to the string, or nullptr.
     *
     * @stable ICU 2.4 
     */
    virtual const char* next(int32_t *resultLength, UErrorCode& status);

    /**
     * <p>Returns the next element as a NUL-terminated char16_t*.  If there
     * are no more elements, returns nullptr.  If the resultLength pointer
     * is not nullptr, the length of the string (not counting the
     * terminating NUL) is returned at that address.  If an error
     * status is returned, the value at resultLength is undefined.</p>
     *
     * <p>The returned pointer is owned by this iterator and must not be
     * deleted by the caller.  The pointer is valid until the next call
     * to next, unext, snext, reset, or the enumerator's destructor.</p>
     *
     * <p>If the iterator is out of sync with its service, status is set
     * to U_ENUM_OUT_OF_SYNC_ERROR and nullptr is returned.</p>
     *
     * Starting with ICU 2.8, the default implementation calls snext()
     * and handles the conversion.
     *
     * @param status the error code.
     * @param resultLength a pointer to receive the length, can be nullptr.
     * @return a pointer to the string, or nullptr.
     *
     * @stable ICU 2.4 
     */
    virtual const char16_t* unext(int32_t *resultLength, UErrorCode& status);

    /**
     * <p>Returns the next element a UnicodeString*.  If there are no
     * more elements, returns nullptr.</p>
     *
     * <p>The returned pointer is owned by this iterator and must not be
     * deleted by the caller.  The pointer is valid until the next call
     * to next, unext, snext, reset, or the enumerator's destructor.</p>
     *
     * <p>If the iterator is out of sync with its service, status is set
     * to U_ENUM_OUT_OF_SYNC_ERROR and nullptr is returned.</p>
     *
     * Starting with ICU 2.8, the default implementation calls next()
     * and handles the conversion.
     * Either next() or snext() must be implemented differently by a subclass.
     *
     * @param status the error code.
     * @return a pointer to the string, or nullptr.
     *
     * @stable ICU 2.4 
     */
    virtual const UnicodeString* snext(UErrorCode& status);

    /**
     * <p>Resets the iterator.  This re-establishes sync with the
     * service and rewinds the iterator to start at the first
     * element.</p>
     *
     * <p>Previous pointers returned by next, unext, or snext become
     * invalid, and the value returned by count might change.</p>
     *
     * @param status the error code.
     *
     * @stable ICU 2.4 
     */
    virtual void reset(UErrorCode& status) = 0;

    /**
     * Compares this enumeration to other to check if both are equal
     *
     * @param that The other string enumeration to compare this object to
     * @return true if the enumerations are equal. false if not.
     * @stable ICU 3.6 
     */
    virtual bool operator==(const StringEnumeration& that)const;
    /**
     * Compares this enumeration to other to check if both are not equal
     *
     * @param that The other string enumeration to compare this object to
     * @return true if the enumerations are equal. false if not.
     * @stable ICU 3.6 
     */
    virtual bool operator!=(const StringEnumeration& that)const;

protected:
    /**
     * UnicodeString field for use with default implementations and subclasses.
     * @stable ICU 2.8
     */
    UnicodeString unistr;
    /**
     * char * default buffer for use with default implementations and subclasses.
     * @stable ICU 2.8
     */
    char charsBuffer[32];
    /**
     * char * buffer for use with default implementations and subclasses.
     * Allocated in constructor and in ensureCharsCapacity().
     * @stable ICU 2.8
     */
    char *chars;
    /**
     * Capacity of chars, for use with default implementations and subclasses.
     * @stable ICU 2.8
     */
    int32_t charsCapacity;

    /**
     * Default constructor for use with default implementations and subclasses.
     * @stable ICU 2.8
     */
    StringEnumeration();

    /**
     * Ensures that chars is at least as large as the requested capacity.
     * For use with default implementations and subclasses.
     *
     * @param capacity Requested capacity.
     * @param status ICU in/out error code.
     * @stable ICU 2.8
     */
    void ensureCharsCapacity(int32_t capacity, UErrorCode &status);

    /**
     * Converts s to Unicode and sets unistr to the result.
     * For use with default implementations and subclasses,
     * especially for implementations of snext() in terms of next().
     * This is provided with a helper function instead of a default implementation
     * of snext() to avoid potential infinite loops between next() and snext().
     *
     * For example:
     * \code
     * const UnicodeString* snext(UErrorCode& status) {
     *   int32_t resultLength=0;
     *   const char *s=next(&resultLength, status);
     *   return setChars(s, resultLength, status);
     * }
     * \endcode
     *
     * @param s String to be converted to Unicode.
     * @param length Length of the string.
     * @param status ICU in/out error code.
     * @return A pointer to unistr.
     * @stable ICU 2.8
     */
    UnicodeString *setChars(const char *s, int32_t length, UErrorCode &status);
};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

/* STRENUM_H */
#endif
