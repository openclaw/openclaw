// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File brkiter.h
*
* Modification History:
*
*   Date        Name        Description
*   02/18/97    aliu        Added typedef for TextCount.  Made DONE const.
*   05/07/97    aliu        Fixed DLL declaration.
*   07/09/97    jfitz       Renamed BreakIterator and interface synced with JDK
*   08/11/98    helena      Sync-up JDK1.2.
*   01/13/2000  helena      Added UErrorCode parameter to createXXXInstance methods.
********************************************************************************
*/

#ifndef BRKITER_H
#define BRKITER_H

#include "unicode/utypes.h"

/**
 * \file
 * \brief C++ API: Break Iterator.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if UCONFIG_NO_BREAK_ITERATION

U_NAMESPACE_BEGIN

/*
 * Allow the declaration of APIs with pointers to BreakIterator
 * even when break iteration is removed from the build.
 */
class BreakIterator;

U_NAMESPACE_END

#else

#include "unicode/uobject.h"
#include "unicode/unistr.h"
#include "unicode/chariter.h"
#include "unicode/locid.h"
#include "unicode/ubrk.h"
#include "unicode/strenum.h"
#include "unicode/utext.h"
#include "unicode/umisc.h"

U_NAMESPACE_BEGIN

/**
 * The BreakIterator class implements methods for finding the location
 * of boundaries in text. BreakIterator is an abstract base class.
 * Instances of BreakIterator maintain a current position and scan over
 * text returning the index of characters where boundaries occur.
 * <p>
 * Line boundary analysis determines where a text string can be broken
 * when line-wrapping. The mechanism correctly handles punctuation and
 * hyphenated words.
 * <p>
 * Sentence boundary analysis allows selection with correct
 * interpretation of periods within numbers and abbreviations, and
 * trailing punctuation marks such as quotation marks and parentheses.
 * <p>
 * Word boundary analysis is used by search and replace functions, as
 * well as within text editing applications that allow the user to
 * select words with a double click. Word selection provides correct
 * interpretation of punctuation marks within and following
 * words. Characters that are not part of a word, such as symbols or
 * punctuation marks, have word-breaks on both sides.
 * <p>
 * Character boundary analysis allows users to interact with
 * characters as they expect to, for example, when moving the cursor
 * through a text string. Character boundary analysis provides correct
 * navigation of through character strings, regardless of how the
 * character is stored.  For example, an accented character might be
 * stored as a base character and a diacritical mark. What users
 * consider to be a character can differ between languages.
 * <p>
 * The text boundary positions are found according to the rules
 * described in Unicode Standard Annex #29, Text Boundaries, and
 * Unicode Standard Annex #14, Line Breaking Properties.  These
 * are available at http://www.unicode.org/reports/tr14/ and
 * http://www.unicode.org/reports/tr29/.
 * <p>
 * In addition to the C++ API defined in this header file, a
 * plain C API with equivalent functionality is defined in the
 * file ubrk.h
 * <p>
 * Code snippets illustrating the use of the Break Iterator APIs
 * are available in the ICU User Guide,
 * https://unicode-org.github.io/icu/userguide/boundaryanalysis/
 * and in the sample program icu/source/samples/break/break.cpp
 *
 */
class U_COMMON_API_CLASS BreakIterator : public UObject {
public:
    /**
     *  destructor
     *  @stable ICU 2.0
     */
    U_COMMON_API virtual ~BreakIterator();

    /**
     * Return true if another object is semantically equal to this
     * one. The other object should be an instance of the same subclass of
     * BreakIterator. Objects of different subclasses are considered
     * unequal.
     * <P>
     * Return true if this BreakIterator is at the same position in the
     * same text, and is the same class and type (word, line, etc.) of
     * BreakIterator, as the argument.  Text is considered the same if
     * it contains the same characters, it need not be the same
     * object, and styles are not considered.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual bool operator==(const BreakIterator&) const = 0;

    /**
     * Returns the complement of the result of operator==
     * @param rhs The BreakIterator to be compared for inequality
     * @return the complement of the result of operator==
     * @stable ICU 2.0
     */
    U_COMMON_API bool operator!=(const BreakIterator& rhs) const { return !operator==(rhs); }

    /**
     * Return a polymorphic copy of this object.  This is an abstract
     * method which subclasses implement.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual BreakIterator* clone() const = 0;

    /**
     * Return a polymorphic class ID for this object. Different subclasses
     * will return distinct unequal values.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual UClassID getDynamicClassID() const override = 0;

    /**
     * Return a CharacterIterator over the text being analyzed.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual CharacterIterator& getText() const = 0;

    /**
      *  Get a UText for the text being analyzed.
      *  The returned UText is a shallow clone of the UText used internally
      *  by the break iterator implementation.  It can safely be used to
      *  access the text without impacting any break iterator operations,
      *  but the underlying text itself must not be altered.
      *
      * @param fillIn A UText to be filled in.  If nullptr, a new UText will be
      *           allocated to hold the result.
      * @param status receives any error codes.
      * @return   The current UText for this break iterator.  If an input
      *           UText was provided, it will always be returned.
      * @stable ICU 3.4
      */
    U_COMMON_API virtual UText* getUText(UText* fillIn, UErrorCode& status) const = 0;

    /**
     * Change the text over which this operates. The text boundary is
     * reset to the start.
     *
     * The BreakIterator will retain a reference to the supplied string.
     * The caller must not modify or delete the text while the BreakIterator
     * retains the reference.
     *
     * @param text The UnicodeString used to change the text.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual void setText(const UnicodeString& text) = 0;

    /**
     * Reset the break iterator to operate over the text represented by
     * the UText.  The iterator position is reset to the start.
     *
     * This function makes a shallow clone of the supplied UText.  This means
     * that the caller is free to immediately close or otherwise reuse the
     * Utext that was passed as a parameter, but that the underlying text itself
     * must not be altered while being referenced by the break iterator.
     *
     * All index positions returned by break iterator functions are
     * native indices from the UText. For example, when breaking UTF-8
     * encoded text, the break positions returned by next(), previous(), etc.
     * will be UTF-8 string indices, not UTF-16 positions.
     *
     * @param text The UText used to change the text.
     * @param status receives any error codes.
     * @stable ICU 3.4
     */
    U_COMMON_API virtual void setText(UText* text, UErrorCode& status) = 0;

    /**
     * Change the text over which this operates. The text boundary is
     * reset to the start.
     * Note that setText(UText *) provides similar functionality to this function,
     * and is more efficient.
     * @param it The CharacterIterator used to change the text.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual void adoptText(CharacterIterator* it) = 0;

    enum {
        /**
         * DONE is returned by previous() and next() after all valid
         * boundaries have been returned.
         * @stable ICU 2.0
         */
        DONE = static_cast<int32_t>(-1)
    };

    /**
     * Sets the current iteration position to the beginning of the text, position zero.
     * @return The offset of the beginning of the text, zero.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t first() = 0;

    /**
     * Set the iterator position to the index immediately BEYOND the last character in the text being scanned.
     * @return The index immediately BEYOND the last character in the text being scanned.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t last() = 0;

    /**
     * Set the iterator position to the boundary preceding the current boundary.
     * @return The character index of the previous text boundary or DONE if all
     * boundaries have been returned.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t previous() = 0;

    /**
     * Advance the iterator to the boundary following the current boundary.
     * @return The character index of the next text boundary or DONE if all
     * boundaries have been returned.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t next() = 0;

    /**
     * Return character index of the current iterator position within the text.
     * @return The boundary most recently returned.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t current() const = 0;

    /**
     * Advance the iterator to the first boundary following the specified offset.
     * The value returned is always greater than the offset or
     * the value BreakIterator.DONE
     * @param offset the offset to begin scanning.
     * @return The first boundary after the specified offset.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t following(int32_t offset) = 0;

    /**
     * Set the iterator position to the first boundary preceding the specified offset.
     * The value returned is always smaller than the offset or
     * the value BreakIterator.DONE
     * @param offset the offset to begin scanning.
     * @return The first boundary before the specified offset.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t preceding(int32_t offset) = 0;

    /**
     * Return true if the specified position is a boundary position.
     * As a side effect, the current position of the iterator is set
     * to the first boundary position at or following the specified offset.
     * @param offset the offset to check.
     * @return True if "offset" is a boundary position.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual UBool isBoundary(int32_t offset) = 0;

    /**
     * Set the iterator position to the nth boundary from the current boundary
     * @param n the number of boundaries to move by.  A value of 0
     * does nothing.  Negative values move to previous boundaries
     * and positive values move to later boundaries.
     * @return The new iterator position, or
     * DONE if there are fewer than |n| boundaries in the specified direction.
     * @stable ICU 2.0
     */
    U_COMMON_API virtual int32_t next(int32_t n) = 0;

    /**
     * For RuleBasedBreakIterators, return the status tag from the break rule
     * that determined the boundary at the current iteration position.
     * <p>
     * For break iterator types that do not support a rule status,
     * a default value of 0 is returned.
     * <p>
     * @return the status from the break rule that determined the boundary at
     *         the current iteration position.
     * @see RuleBaseBreakIterator::getRuleStatus()
     * @see UWordBreak
     * @stable ICU 52
     */
    U_COMMON_API virtual int32_t getRuleStatus() const;

   /**
    * For RuleBasedBreakIterators, get the status (tag) values from the break rule(s)
    * that determined the boundary at the current iteration position.
    * <p>
    * For break iterator types that do not support rule status,
    * no values are returned.
    * <p>
    * The returned status value(s) are stored into an array provided by the caller.
    * The values are stored in sorted (ascending) order.
    * If the capacity of the output array is insufficient to hold the data,
    *  the output will be truncated to the available length, and a
    *  U_BUFFER_OVERFLOW_ERROR will be signaled.
    * <p>
    * @see RuleBaseBreakIterator::getRuleStatusVec
    *
    * @param fillInVec an array to be filled in with the status values.
    * @param capacity  the length of the supplied vector.  A length of zero causes
    *                  the function to return the number of status values, in the
    *                  normal way, without attempting to store any values.
    * @param status    receives error codes.
    * @return          The number of rule status values from rules that determined
    *                  the boundary at the current iteration position.
    *                  In the event of a U_BUFFER_OVERFLOW_ERROR, the return value
    *                  is the total number of status values that were available,
    *                  not the reduced number that were actually returned.
    * @see getRuleStatus
    * @stable ICU 52
    */
    U_COMMON_API virtual int32_t getRuleStatusVec(int32_t* fillInVec,
                                                  int32_t capacity,
                                                  UErrorCode& status);

    /**
     * Create BreakIterator for word-breaks using the given locale.
     * Returns an instance of a BreakIterator implementing word breaks.
     * WordBreak is useful for word selection (ex. double click)
     * @param where the locale.
     * @param status the error code
     * @return A BreakIterator for word-breaks.  The UErrorCode& status
     * parameter is used to return status information to the user.
     * To check whether the construction succeeded or not, you should check
     * the value of U_SUCCESS(err).  If you wish more detailed information, you
     * can check for informational error results which still indicate success.
     * U_USING_FALLBACK_WARNING indicates that a fall back locale was used.  For
     * example, 'de_CH' was requested, but nothing was found there, so 'de' was
     * used.  U_USING_DEFAULT_WARNING indicates that the default locale data was
     * used; neither the requested locale nor any of its fall back locales
     * could be found.
     * The caller owns the returned object and is responsible for deleting it.
     * @stable ICU 2.0
     */
    U_COMMON_API static BreakIterator* U_EXPORT2
    createWordInstance(const Locale& where, UErrorCode& status);

    /**
     * Create BreakIterator for line-breaks using specified locale.
     * Returns an instance of a BreakIterator implementing line breaks. Line
     * breaks are logically possible line breaks, actual line breaks are
     * usually determined based on display width.
     * LineBreak is useful for word wrapping text.
     * @param where the locale.
     * @param status The error code.
     * @return A BreakIterator for line-breaks.  The UErrorCode& status
     * parameter is used to return status information to the user.
     * To check whether the construction succeeded or not, you should check
     * the value of U_SUCCESS(err).  If you wish more detailed information, you
     * can check for informational error results which still indicate success.
     * U_USING_FALLBACK_WARNING indicates that a fall back locale was used.  For
     * example, 'de_CH' was requested, but nothing was found there, so 'de' was
     * used.  U_USING_DEFAULT_WARNING indicates that the default locale data was
     * used; neither the requested locale nor any of its fall back locales
     * could be found.
     * The caller owns the returned object and is responsible for deleting it.
     * @stable ICU 2.0
     */
    U_COMMON_API static BreakIterator* U_EXPORT2
    createLineInstance(const Locale& where, UErrorCode& status);

    /**
     * Create BreakIterator for character-breaks using specified locale
     * Returns an instance of a BreakIterator implementing character breaks.
     * Character breaks are boundaries of combining character sequences.
     * @param where the locale.
     * @param status The error code.
     * @return A BreakIterator for character-breaks.  The UErrorCode& status
     * parameter is used to return status information to the user.
     * To check whether the construction succeeded or not, you should check
     * the value of U_SUCCESS(err).  If you wish more detailed information, you
     * can check for informational error results which still indicate success.
     * U_USING_FALLBACK_WARNING indicates that a fall back locale was used.  For
     * example, 'de_CH' was requested, but nothing was found there, so 'de' was
     * used.  U_USING_DEFAULT_WARNING indicates that the default locale data was
     * used; neither the requested locale nor any of its fall back locales
     * could be found.
     * The caller owns the returned object and is responsible for deleting it.
     * @stable ICU 2.0
     */
    U_COMMON_API static BreakIterator* U_EXPORT2
    createCharacterInstance(const Locale& where, UErrorCode& status);

    /**
     * Create BreakIterator for sentence-breaks using specified locale
     * Returns an instance of a BreakIterator implementing sentence breaks.
     * @param where the locale.
     * @param status The error code.
     * @return A BreakIterator for sentence-breaks.  The UErrorCode& status
     * parameter is used to return status information to the user.
     * To check whether the construction succeeded or not, you should check
     * the value of U_SUCCESS(err).  If you wish more detailed information, you
     * can check for informational error results which still indicate success.
     * U_USING_FALLBACK_WARNING indicates that a fall back locale was used.  For
     * example, 'de_CH' was requested, but nothing was found there, so 'de' was
     * used.  U_USING_DEFAULT_WARNING indicates that the default locale data was
     * used; neither the requested locale nor any of its fall back locales
     * could be found.
     * The caller owns the returned object and is responsible for deleting it.
     * @stable ICU 2.0
     */
    U_COMMON_API static BreakIterator* U_EXPORT2
    createSentenceInstance(const Locale& where, UErrorCode& status);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Create BreakIterator for title-casing breaks using the specified locale
     * Returns an instance of a BreakIterator implementing title breaks.
     * The iterator returned locates title boundaries as described for
     * Unicode 3.2 only. For Unicode 4.0 and above title boundary iteration,
     * please use a word boundary iterator. See {@link #createWordInstance }.
     *
     * @param where the locale.
     * @param status The error code.
     * @return A BreakIterator for title-breaks.  The UErrorCode& status
     * parameter is used to return status information to the user.
     * To check whether the construction succeeded or not, you should check
     * the value of U_SUCCESS(err).  If you wish more detailed information, you
     * can check for informational error results which still indicate success.
     * U_USING_FALLBACK_WARNING indicates that a fall back locale was used.  For
     * example, 'de_CH' was requested, but nothing was found there, so 'de' was
     * used.  U_USING_DEFAULT_WARNING indicates that the default locale data was
     * used; neither the requested locale nor any of its fall back locales
     * could be found.
     * The caller owns the returned object and is responsible for deleting it.
     * @deprecated ICU 64 Use createWordInstance instead.
     */
    U_COMMON_API static BreakIterator* U_EXPORT2
    createTitleInstance(const Locale& where, UErrorCode& status);
#endif /* U_HIDE_DEPRECATED_API */

    /**
     * Get the set of Locales for which TextBoundaries are installed.
     * <p><b>Note:</b> this will not return locales added through the register
     * call. To see the registered locales too, use the getAvailableLocales
     * function that returns a StringEnumeration object </p>
     * @param count the output parameter of number of elements in the locale list
     * @return available locales
     * @stable ICU 2.0
     */
    U_COMMON_API static const Locale* U_EXPORT2 getAvailableLocales(int32_t& count);

    /**
     * Get name of the object for the desired Locale, in the desired language.
     * @param objectLocale must be from getAvailableLocales.
     * @param displayLocale specifies the desired locale for output.
     * @param name the fill-in parameter of the return value
     * Uses best match.
     * @return user-displayable name
     * @stable ICU 2.0
     */
    U_COMMON_API static UnicodeString& U_EXPORT2 getDisplayName(const Locale& objectLocale,
                                                                const Locale& displayLocale,
                                                                UnicodeString& name);

    /**
     * Get name of the object for the desired Locale, in the language of the
     * default locale.
     * @param objectLocale must be from getMatchingLocales
     * @param name the fill-in parameter of the return value
     * @return user-displayable name
     * @stable ICU 2.0
     */
    U_COMMON_API static UnicodeString& U_EXPORT2 getDisplayName(const Locale& objectLocale,
                                                                UnicodeString& name);

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Deprecated functionality. Use clone() instead.
     *
     * Thread safe client-buffer-based cloning operation
     *    Do NOT call delete on a safeclone, since 'new' is not used to create it.
     * @param stackBuffer user allocated space for the new clone. If nullptr new memory will be allocated.
     * If buffer is not large enough, new memory will be allocated.
     * @param BufferSize reference to size of allocated space.
     * If BufferSize == 0, a sufficient size for use in cloning will
     * be returned ('pre-flighting')
     * If BufferSize is not enough for a stack-based safe clone,
     * new memory will be allocated.
     * @param status to indicate whether the operation went on smoothly or there were errors
     *  An informational status value, U_SAFECLONE_ALLOCATED_ERROR, is used if any allocations were
     *  necessary.
     * @return pointer to the new clone
     *
     * @deprecated ICU 52. Use clone() instead.
     */
    U_COMMON_API virtual BreakIterator* createBufferClone(void* stackBuffer,
                                                          int32_t& BufferSize,
                                                          UErrorCode& status) = 0;
#endif  // U_FORCE_HIDE_DEPRECATED_API

#ifndef U_HIDE_DEPRECATED_API

    /**
     *   Determine whether the BreakIterator was created in user memory by
     *   createBufferClone(), and thus should not be deleted.  Such objects
     *   must be closed by an explicit call to the destructor (not delete).
     * @deprecated ICU 52. Always delete the BreakIterator.
     */
    U_COMMON_API inline UBool isBufferClone();

#endif /* U_HIDE_DEPRECATED_API */

#if !UCONFIG_NO_SERVICE
    /**
     * Register a new break iterator of the indicated kind, to use in the given locale.
     * The break iterator will be adopted.  Clones of the iterator will be returned
     * if a request for a break iterator of the given kind matches or falls back to
     * this locale.
     * Because ICU may choose to cache BreakIterators internally, this must
     * be called at application startup, prior to any calls to
     * BreakIterator::createXXXInstance to avoid undefined behavior.
     * @param toAdopt the BreakIterator instance to be adopted
     * @param locale the Locale for which this instance is to be registered
     * @param kind the type of iterator for which this instance is to be registered
     * @param status the in/out status code, no special meanings are assigned
     * @return a registry key that can be used to unregister this instance
     * @stable ICU 2.4
     */
    U_COMMON_API static URegistryKey U_EXPORT2 registerInstance(BreakIterator* toAdopt,
                                                                const Locale& locale,
                                                                UBreakIteratorType kind,
                                                                UErrorCode& status);

    /**
     * Unregister a previously-registered BreakIterator using the key returned from the
     * register call.  Key becomes invalid after a successful call and should not be used again.
     * The BreakIterator corresponding to the key will be deleted.
     * Because ICU may choose to cache BreakIterators internally, this should
     * be called during application shutdown, after all calls to
     * BreakIterator::createXXXInstance to avoid undefined behavior.
     * @param key the registry key returned by a previous call to registerInstance
     * @param status the in/out status code, no special meanings are assigned
     * @return true if the iterator for the key was successfully unregistered
     * @stable ICU 2.4
     */
    U_COMMON_API static UBool U_EXPORT2 unregister(URegistryKey key, UErrorCode& status);

    /**
     * Return a StringEnumeration over the locales available at the time of the call,
     * including registered locales.
     * @return a StringEnumeration over the locales available at the time of the call
     * @stable ICU 2.4
     */
    U_COMMON_API static StringEnumeration* U_EXPORT2 getAvailableLocales();
#endif

    /**
     * Returns the locale for this break iterator. Two flavors are available: valid and
     * actual locale.
     * @stable ICU 2.8
     */
    U_COMMON_API Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const;

#ifndef U_HIDE_INTERNAL_API
    /** Get the locale for this break iterator object. You can choose between valid and actual locale.
     *  @param type type of the locale we're looking for (valid or actual)
     *  @param status error code for the operation
     *  @return the locale
     *  @internal
     */
    U_COMMON_API const char* getLocaleID(ULocDataLocaleType type, UErrorCode& status) const;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     *  Set the subject text string upon which the break iterator is operating
     *  without changing any other aspect of the matching state.
     *  The new and previous text strings must have the same content.
     *
     *  This function is intended for use in environments where ICU is operating on
     *  strings that may move around in memory.  It provides a mechanism for notifying
     *  ICU that the string has been relocated, and providing a new UText to access the
     *  string in its new position.
     *
     *  Note that the break iterator implementation never copies the underlying text
     *  of a string being processed, but always operates directly on the original text
     *  provided by the user. Refreshing simply drops the references to the old text
     *  and replaces them with references to the new.
     *
     *  Caution:  this function is normally used only by very specialized,
     *  system-level code.  One example use case is with garbage collection that moves
     *  the text in memory.
     *
     * @param input      The new (moved) text string.
     * @param status     Receives errors detected by this function.
     * @return           *this
     *
     * @stable ICU 49
     */
    U_COMMON_API virtual BreakIterator& refreshInputText(UText* input, UErrorCode& status) = 0;

 private:
    static BreakIterator* buildInstance(const Locale& loc, const char *type, UErrorCode& status);
    static BreakIterator* createInstance(const Locale& loc, int32_t kind, UErrorCode& status);
    static BreakIterator* makeInstance(const Locale& loc, int32_t kind, UErrorCode& status);

    friend class ICUBreakIteratorFactory;
    friend class ICUBreakIteratorService;

protected:
    // Do not enclose protected default/copy constructors with #ifndef U_HIDE_INTERNAL_API
    // or else the compiler will create a public ones.
    /** @internal */
    U_COMMON_API BreakIterator();
    /** @internal */
    U_COMMON_API BreakIterator(const BreakIterator& other);
#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    U_COMMON_API BreakIterator(const Locale& valid, const Locale& actual);
    /** @internal. Assignment Operator, used by RuleBasedBreakIterator. */
    U_COMMON_API BreakIterator& operator=(const BreakIterator& other);
#endif  /* U_HIDE_INTERNAL_API */

private:

    Locale actualLocale;
    Locale validLocale;
    Locale requestLocale;
};

#ifndef U_HIDE_DEPRECATED_API

inline UBool BreakIterator::isBufferClone()
{
    return false;
}

#endif /* U_HIDE_DEPRECATED_API */

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_BREAK_ITERATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // BRKITER_H
//eof
