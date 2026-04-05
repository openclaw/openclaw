// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
* Copyright (C) 1996-2016, International Business Machines Corporation and
* others. All Rights Reserved.
******************************************************************************
*/

/**
 * \file
 * \brief C++ API: The RuleBasedCollator class implements the Collator abstract base class.
 */

/**
* File tblcoll.h
*
* Created by: Helena Shih
*
* Modification History:
*
*  Date        Name        Description
*  2/5/97      aliu        Added streamIn and streamOut methods.  Added
*                          constructor which reads RuleBasedCollator object from
*                          a binary file.  Added writeToFile method which streams
*                          RuleBasedCollator out to a binary file.  The streamIn
*                          and streamOut methods use istream and ostream objects
*                          in binary mode.
*  2/12/97     aliu        Modified to use TableCollationData sub-object to
*                          hold invariant data.
*  2/13/97     aliu        Moved several methods into this class from Collation.
*                          Added a private RuleBasedCollator(Locale&) constructor,
*                          to be used by Collator::createDefault().  General
*                          clean up.
*  2/20/97     helena      Added clone, operator==, operator!=, operator=, and copy
*                          constructor and getDynamicClassID.
*  3/5/97      aliu        Modified constructFromFile() to add parameter
*                          specifying whether or not binary loading is to be
*                          attempted.  This is required for dynamic rule loading.
* 05/07/97     helena      Added memory allocation error detection.
*  6/17/97     helena      Added IDENTICAL strength for compare, changed getRules to
*                          use MergeCollation::getPattern.
*  6/20/97     helena      Java class name change.
*  8/18/97     helena      Added internal API documentation.
* 09/03/97     helena      Added createCollationKeyValues().
* 02/10/98     damiba      Added compare with "length" parameter
* 08/05/98     erm         Synched with 1.2 version of RuleBasedCollator.java
* 04/23/99     stephen     Removed EDecompositionMode, merged with
*                          Normalizer::EMode
* 06/14/99     stephen     Removed kResourceBundleSuffix
* 11/02/99     helena      Collator performance enhancements.  Eliminates the
*                          UnicodeString construction and special case for NO_OP.
* 11/23/99     srl         More performance enhancements. Updates to NormalizerIterator
*                          internal state management.
* 12/15/99     aliu        Update to support Thai collation.  Move NormalizerIterator
*                          to implementation file.
* 01/29/01     synwee      Modified into a C++ wrapper which calls C API
*                          (ucol.h)
* 2012-2014    markus      Rewritten in C++ again.
*/

#ifndef TBLCOLL_H
#define TBLCOLL_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_COLLATION

#include "unicode/coll.h"
#include "unicode/locid.h"
#include "unicode/uiter.h"
#include "unicode/ucol.h"

U_NAMESPACE_BEGIN

struct CollationCacheEntry;
struct CollationData;
struct CollationSettings;
struct CollationTailoring;
/**
* @stable ICU 2.0
*/
class StringSearch;
/**
* @stable ICU 2.0
*/
class CollationElementIterator;
class CollationKey;
class SortKeyByteSink;
class UnicodeSet;
class UnicodeString;
class UVector64;

/**
 * The RuleBasedCollator class provides the implementation of
 * Collator, using data-driven tables. The user can create a customized
 * table-based collation.
 * <p>
 * For more information about the collation service see
 * <a href="https://unicode-org.github.io/icu/userguide/collation">the User Guide</a>.
 * <p>
 * Collation service provides correct sorting orders for most locales supported in ICU.
 * If specific data for a locale is not available, the orders eventually falls back
 * to the <a href="http://www.unicode.org/reports/tr35/tr35-collation.html#Root_Collation">CLDR root sort order</a>.
 * <p>
 * Sort ordering may be customized by providing your own set of rules. For more on
 * this subject see the <a href="https://unicode-org.github.io/icu/userguide/collation/customization">
 * Collation Customization</a> section of the User Guide.
 * <p>
 * Note, RuleBasedCollator is not to be subclassed.
 * @see        Collator
 */
class U_I18N_API_CLASS RuleBasedCollator final : public Collator {
public:
    /**
     * RuleBasedCollator constructor. This takes the table rules and builds a
     * collation table out of them. Please see RuleBasedCollator class
     * description for more details on the collation rule syntax.
     * @param rules the collation rules to build the collation table from.
     * @param status reporting a success or an error.
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator(const UnicodeString& rules, UErrorCode& status);

    /**
     * RuleBasedCollator constructor. This takes the table rules and builds a
     * collation table out of them. Please see RuleBasedCollator class
     * description for more details on the collation rule syntax.
     * @param rules the collation rules to build the collation table from.
     * @param collationStrength strength for comparison
     * @param status reporting a success or an error.
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator(const UnicodeString& rules,
                                 ECollationStrength collationStrength,
                                 UErrorCode& status);

    /**
     * RuleBasedCollator constructor. This takes the table rules and builds a
     * collation table out of them. Please see RuleBasedCollator class
     * description for more details on the collation rule syntax.
     * @param rules the collation rules to build the collation table from.
     * @param decompositionMode the normalisation mode
     * @param status reporting a success or an error.
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator(const UnicodeString& rules,
                                 UColAttributeValue decompositionMode,
                                 UErrorCode& status);

    /**
     * RuleBasedCollator constructor. This takes the table rules and builds a
     * collation table out of them. Please see RuleBasedCollator class
     * description for more details on the collation rule syntax.
     * @param rules the collation rules to build the collation table from.
     * @param collationStrength strength for comparison
     * @param decompositionMode the normalisation mode
     * @param status reporting a success or an error.
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator(const UnicodeString& rules,
                                 ECollationStrength collationStrength,
                                 UColAttributeValue decompositionMode,
                                 UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * TODO: document & propose as public API
     * @internal
     */
    U_I18N_API RuleBasedCollator(const UnicodeString& rules,
                                 UParseError& parseError,
                                 UnicodeString& reason,
                                 UErrorCode& errorCode);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Copy constructor.
     * @param other the RuleBasedCollator object to be copied
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator(const RuleBasedCollator& other);

    /** Opens a collator from a collator binary image created using
    *  cloneBinary. Binary image used in instantiation of the
    *  collator remains owned by the user and should stay around for
    *  the lifetime of the collator. The API also takes a base collator
    *  which must be the root collator.
    *  @param bin binary image owned by the user and required through the
    *             lifetime of the collator
    *  @param length size of the image. If negative, the API will try to
    *                figure out the length of the image
    *  @param base Base collator, for lookup of untailored characters.
    *              Must be the root collator, must not be nullptr.
    *              The base is required to be present through the lifetime of the collator.
    *  @param status for catching errors
    *  @return newly created collator
    *  @see cloneBinary
    *  @stable ICU 3.4
    */
    U_I18N_API RuleBasedCollator(const uint8_t* bin,
                                 int32_t length,
                                 const RuleBasedCollator* base,
                                 UErrorCode& status);

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~RuleBasedCollator();

    /**
     * Assignment operator.
     * @param other other RuleBasedCollator object to copy from.
     * @stable ICU 2.0
     */
    U_I18N_API RuleBasedCollator& operator=(const RuleBasedCollator& other);

    /**
     * Returns true if argument is the same as this object.
     * @param other Collator object to be compared.
     * @return true if arguments is the same as this object.
     * @stable ICU 2.0
     */
    U_I18N_API virtual bool operator==(const Collator& other) const override;

    /**
     * Makes a copy of this object.
     * @return a copy of this object, owned by the caller
     * @stable ICU 2.0
     */
    U_I18N_API virtual RuleBasedCollator* clone() const override;

    /**
     * Creates a collation element iterator for the source string. The caller of
     * this method is responsible for the memory management of the return
     * pointer.
     * @param source the string over which the CollationElementIterator will
     *        iterate.
     * @return the collation element iterator of the source string using this as
     *         the based Collator.
     * @stable ICU 2.2
     */
    U_I18N_API CollationElementIterator*
    createCollationElementIterator(const UnicodeString& source) const;

    /**
     * Creates a collation element iterator for the source. The caller of this
     * method is responsible for the memory management of the returned pointer.
     * @param source the CharacterIterator which produces the characters over
     *        which the CollationElementItgerator will iterate.
     * @return the collation element iterator of the source using this as the
     *         based Collator.
     * @stable ICU 2.2
     */
    U_I18N_API CollationElementIterator*
    createCollationElementIterator(const CharacterIterator& source) const;

    // Make deprecated versions of Collator::compare() visible.
    using Collator::compare;

    /**
    * The comparison function compares the character data stored in two
    * different strings. Returns information about whether a string is less
    * than, greater than or equal to another string.
    * @param source the source string to be compared with.
    * @param target the string that is to be compared with the source string.
    * @param status possible error code
    * @return Returns an enum value. UCOL_GREATER if source is greater
    * than target; UCOL_EQUAL if source is equal to target; UCOL_LESS if source is less
    * than target
    * @stable ICU 2.6
    **/
    U_I18N_API virtual UCollationResult compare(const UnicodeString& source,
                                                const UnicodeString& target,
                                                UErrorCode& status) const override;

    /**
    * Does the same thing as compare but limits the comparison to a specified
    * length
    * @param source the source string to be compared with.
    * @param target the string that is to be compared with the source string.
    * @param length the length the comparison is limited to
    * @param status possible error code
    * @return Returns an enum value. UCOL_GREATER if source (up to the specified
    *         length) is greater than target; UCOL_EQUAL if source (up to specified
    *         length) is equal to target; UCOL_LESS if source (up to the specified
    *         length) is less  than target.
    * @stable ICU 2.6
    */
    U_I18N_API virtual UCollationResult compare(const UnicodeString& source,
                                                const UnicodeString& target,
                                                int32_t length,
                                                UErrorCode& status) const override;

    /**
    * The comparison function compares the character data stored in two
    * different string arrays. Returns information about whether a string array
    * is less than, greater than or equal to another string array.
    * @param source the source string array to be compared with.
    * @param sourceLength the length of the source string array.  If this value
    *        is equal to -1, the string array is null-terminated.
    * @param target the string that is to be compared with the source string.
    * @param targetLength the length of the target string array.  If this value
    *        is equal to -1, the string array is null-terminated.
    * @param status possible error code
    * @return Returns an enum value. UCOL_GREATER if source is greater
    * than target; UCOL_EQUAL if source is equal to target; UCOL_LESS if source is less
    * than target
    * @stable ICU 2.6
    */
    U_I18N_API virtual UCollationResult compare(const char16_t* source, int32_t sourceLength,
                                                const char16_t* target, int32_t targetLength,
                                                UErrorCode& status) const override;

    /**
     * Compares two strings using the Collator.
     * Returns whether the first one compares less than/equal to/greater than
     * the second one.
     * This version takes UCharIterator input.
     * @param sIter the first ("source") string iterator
     * @param tIter the second ("target") string iterator
     * @param status ICU status
     * @return UCOL_LESS, UCOL_EQUAL or UCOL_GREATER
     * @stable ICU 4.2
     */
    U_I18N_API virtual UCollationResult compare(UCharIterator& sIter,
                                                UCharIterator& tIter,
                                                UErrorCode& status) const override;

    /**
     * Compares two UTF-8 strings using the Collator.
     * Returns whether the first one compares less than/equal to/greater than
     * the second one.
     * This version takes UTF-8 input.
     * Note that a StringPiece can be implicitly constructed
     * from a std::string or a NUL-terminated const char * string.
     * @param source the first UTF-8 string
     * @param target the second UTF-8 string
     * @param status ICU status
     * @return UCOL_LESS, UCOL_EQUAL or UCOL_GREATER
     * @stable ICU 51
     */
    U_I18N_API virtual UCollationResult compareUTF8(const StringPiece& source,
                                                    const StringPiece& target,
                                                    UErrorCode& status) const override;

    /**
     * Transforms the string into a series of characters
     * that can be compared with CollationKey.compare().
     *
     * Note that sort keys are often less efficient than simply doing comparison.
     * For more details, see the ICU User Guide.
     *
     * @param source the source string.
     * @param key the transformed key of the source string.
     * @param status the error code status.
     * @return the transformed key.
     * @see CollationKey
     * @stable ICU 2.0
     */
    U_I18N_API virtual CollationKey& getCollationKey(const UnicodeString& source,
                                                     CollationKey& key,
                                                     UErrorCode& status) const override;

    /**
     * Transforms a specified region of the string into a series of characters
     * that can be compared with CollationKey.compare.
     *
     * Note that sort keys are often less efficient than simply doing comparison.
     * For more details, see the ICU User Guide.
     *
     * @param source the source string.
     * @param sourceLength the length of the source string.
     * @param key the transformed key of the source string.
     * @param status the error code status.
     * @return the transformed key.
     * @see CollationKey
     * @stable ICU 2.0
     */
    U_I18N_API virtual CollationKey& getCollationKey(const char16_t* source,
                                                     int32_t sourceLength,
                                                     CollationKey& key,
                                                     UErrorCode& status) const override;

    /**
     * Generates the hash code for the rule-based collation object.
     * @return the hash code.
     * @stable ICU 2.0
     */
    U_I18N_API virtual int32_t hashCode() const override;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
    * Gets the locale of the Collator
    * @param type can be either requested, valid or actual locale. For more
    *             information see the definition of ULocDataLocaleType in
    *             uloc.h
    * @param status the error code status.
    * @return locale where the collation data lives. If the collator
    *         was instantiated from rules, locale is empty.
    * @deprecated ICU 2.8 likely to change in ICU 3.0, based on feedback
    */
    U_I18N_API virtual Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the tailoring rules for this collator.
     * @return the collation tailoring from which this collator was created
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString& getRules() const;

    /**
     * Gets the version information for a Collator.
     * @param info the version # information, the result will be filled in
     * @stable ICU 2.0
     */
    U_I18N_API virtual void getVersion(UVersionInfo info) const override;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns the maximum length of any expansion sequences that end with the
     * specified comparison order.
     *
     * This is specific to the kind of collation element values and sequences
     * returned by the CollationElementIterator.
     * Call CollationElementIterator::getMaxExpansion() instead.
     *
     * @param order a collation order returned by CollationElementIterator::previous
     *              or CollationElementIterator::next.
     * @return maximum size of the expansion sequences ending with the collation
     *         element, or 1 if the collation element does not occur at the end of
     *         any expansion sequence
     * @see CollationElementIterator#getMaxExpansion
     * @deprecated ICU 51 Use CollationElementIterator::getMaxExpansion() instead.
     */
    U_I18N_API int32_t getMaxExpansion(int32_t order) const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     * @return The class ID for this object. All objects of a given class have
     *         the same class ID. Objects of other classes have different class
     *         IDs.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

    /**
     * Returns the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * Base* polymorphic_pointer = createPolymorphicObject();
     * if (polymorphic_pointer->getDynamicClassID() ==
     *                                          Derived::getStaticClassID()) ...
     * </pre>
     * @return The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    U_I18N_API static UClassID getStaticClassID();

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Do not use this method: The caller and the ICU library might use different heaps.
     * Use cloneBinary() instead which writes to caller-provided memory.
     *
     * Returns a binary format of this collator.
     * @param length Returns the length of the data, in bytes
     * @param status the error code status.
     * @return memory, owned by the caller, of size 'length' bytes.
     * @deprecated ICU 52. Use cloneBinary() instead.
     */
    U_I18N_API uint8_t* cloneRuleData(int32_t& length, UErrorCode& status) const;
#endif  /* U_HIDE_DEPRECATED_API */

    /** Creates a binary image of a collator. This binary image can be stored and
    *  later used to instantiate a collator using ucol_openBinary.
    *  This API supports preflighting.
    *  @param buffer a fill-in buffer to receive the binary image
    *  @param capacity capacity of the destination buffer
    *  @param status for catching errors
    *  @return size of the image
    *  @see ucol_openBinary
    *  @stable ICU 3.4
    */
    U_I18N_API int32_t cloneBinary(uint8_t* buffer, int32_t capacity, UErrorCode& status) const;

    /**
     * Returns current rules. Delta defines whether full rules are returned or
     * just the tailoring.
     *
     * getRules(void) should normally be used instead.
     * See https://unicode-org.github.io/icu/userguide/collation/customization#building-on-existing-locales
     * @param delta one of UCOL_TAILORING_ONLY, UCOL_FULL_RULES.
     * @param buffer UnicodeString to store the result rules
     * @stable ICU 2.2
     * @see UCOL_FULL_RULES
     */
    U_I18N_API void getRules(UColRuleOption delta, UnicodeString& buffer) const;

    /**
     * Universal attribute setter
     * @param attr attribute type
     * @param value attribute value
     * @param status to indicate whether the operation went on smoothly or there were errors
     * @stable ICU 2.2
     */
    U_I18N_API virtual void setAttribute(UColAttribute attr,
                                         UColAttributeValue value,
                                         UErrorCode& status) override;

    /**
     * Universal attribute getter.
     * @param attr attribute type
     * @param status to indicate whether the operation went on smoothly or there were errors
     * @return attribute value
     * @stable ICU 2.2
     */
    U_I18N_API virtual UColAttributeValue getAttribute(UColAttribute attr,
                                                       UErrorCode& status) const override;

    /**
     * Sets the variable top to the top of the specified reordering group.
     * The variable top determines the highest-sorting character
     * which is affected by UCOL_ALTERNATE_HANDLING.
     * If that attribute is set to UCOL_NON_IGNORABLE, then the variable top has no effect.
     * @param group one of UCOL_REORDER_CODE_SPACE, UCOL_REORDER_CODE_PUNCTUATION,
     *              UCOL_REORDER_CODE_SYMBOL, UCOL_REORDER_CODE_CURRENCY;
     *              or UCOL_REORDER_CODE_DEFAULT to restore the default max variable group
     * @param errorCode Standard ICU error code. Its input value must
     *                  pass the U_SUCCESS() test, or else the function returns
     *                  immediately. Check for U_FAILURE() on output or use with
     *                  function chaining. (See User Guide for details.)
     * @return *this
     * @see getMaxVariable
     * @stable ICU 53
     */
    U_I18N_API virtual Collator& setMaxVariable(UColReorderCode group, UErrorCode& errorCode) override;

    /**
     * Returns the maximum reordering group whose characters are affected by UCOL_ALTERNATE_HANDLING.
     * @return the maximum variable reordering group.
     * @see setMaxVariable
     * @stable ICU 53
     */
    U_I18N_API virtual UColReorderCode getMaxVariable() const override;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Sets the variable top to the primary weight of the specified string.
     *
     * Beginning with ICU 53, the variable top is pinned to
     * the top of one of the supported reordering groups,
     * and it must not be beyond the last of those groups.
     * See setMaxVariable().
     * @param varTop one or more (if contraction) char16_ts to which the variable top should be set
     * @param len length of variable top string. If -1 it is considered to be zero terminated.
     * @param status error code. If error code is set, the return value is undefined. Errors set by this function are: <br>
     *    U_CE_NOT_FOUND_ERROR if more than one character was passed and there is no such contraction<br>
     *    U_ILLEGAL_ARGUMENT_ERROR if the variable top is beyond
     *    the last reordering group supported by setMaxVariable()
     * @return variable top primary weight
     * @deprecated ICU 53 Call setMaxVariable() instead.
     */
    U_I18N_API virtual uint32_t setVariableTop(const char16_t* varTop,
                                               int32_t len,
                                               UErrorCode& status) override;

    /**
     * Sets the variable top to the primary weight of the specified string.
     *
     * Beginning with ICU 53, the variable top is pinned to
     * the top of one of the supported reordering groups,
     * and it must not be beyond the last of those groups.
     * See setMaxVariable().
     * @param varTop a UnicodeString size 1 or more (if contraction) of char16_ts to which the variable top should be set
     * @param status error code. If error code is set, the return value is undefined. Errors set by this function are: <br>
     *    U_CE_NOT_FOUND_ERROR if more than one character was passed and there is no such contraction<br>
     *    U_ILLEGAL_ARGUMENT_ERROR if the variable top is beyond
     *    the last reordering group supported by setMaxVariable()
     * @return variable top primary weight
     * @deprecated ICU 53 Call setMaxVariable() instead.
     */
    U_I18N_API virtual uint32_t setVariableTop(const UnicodeString& varTop, UErrorCode& status) override;

    /**
     * Sets the variable top to the specified primary weight.
     *
     * Beginning with ICU 53, the variable top is pinned to
     * the top of one of the supported reordering groups,
     * and it must not be beyond the last of those groups.
     * See setMaxVariable().
     * @param varTop primary weight, as returned by setVariableTop or ucol_getVariableTop
     * @param status error code
     * @deprecated ICU 53 Call setMaxVariable() instead.
     */
    U_I18N_API virtual void setVariableTop(uint32_t varTop, UErrorCode& status) override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the variable top value of a Collator.
     * @param status error code (not changed by function). If error code is set, the return value is undefined.
     * @return the variable top primary weight
     * @see getMaxVariable
     * @stable ICU 2.0
     */
    U_I18N_API virtual uint32_t getVariableTop(UErrorCode& status) const override;

    /**
     * Get a UnicodeSet that contains all the characters and sequences tailored in
     * this collator.
     * @param status      error code of the operation
     * @return a pointer to a UnicodeSet object containing all the
     *         code points and sequences that may sort differently than
     *         in the root collator. The object must be disposed of by using delete
     * @stable ICU 2.4
     */
    U_I18N_API virtual UnicodeSet* getTailoredSet(UErrorCode& status) const override;

    /**
     * Get the sort key as an array of bytes from a UnicodeString.
     *
     * Note that sort keys are often less efficient than simply doing comparison.
     * For more details, see the ICU User Guide.
     *
     * @param source string to be processed.
     * @param result buffer to store result in. If nullptr, number of bytes needed
     *        will be returned.
     * @param resultLength length of the result buffer. If if not enough the
     *        buffer will be filled to capacity.
     * @return Number of bytes needed for storing the sort key
     * @stable ICU 2.0
     */
    U_I18N_API virtual int32_t getSortKey(const UnicodeString& source,
                                          uint8_t* result,
                                          int32_t resultLength) const override;

    /**
     * Get the sort key as an array of bytes from a char16_t buffer.
     *
     * Note that sort keys are often less efficient than simply doing comparison.
     * For more details, see the ICU User Guide.
     *
     * @param source string to be processed.
     * @param sourceLength length of string to be processed. If -1, the string
     *        is 0 terminated and length will be decided by the function.
     * @param result buffer to store result in. If nullptr, number of bytes needed
     *        will be returned.
     * @param resultLength length of the result buffer. If if not enough the
     *        buffer will be filled to capacity.
     * @return Number of bytes needed for storing the sort key
     * @stable ICU 2.2
     */
    U_I18N_API virtual int32_t getSortKey(const char16_t* source,
                                          int32_t sourceLength,
                                          uint8_t* result,
                                          int32_t resultLength) const override;

    /**
     * Retrieves the reordering codes for this collator.
     * @param dest The array to fill with the script ordering.
     * @param destCapacity The length of dest. If it is 0, then dest may be nullptr and the function
     *  will only return the length of the result without writing any codes (pre-flighting).
     * @param status A reference to an error code value, which must not indicate
     * a failure before the function call.
     * @return The length of the script ordering array.
     * @see ucol_setReorderCodes
     * @see Collator#getEquivalentReorderCodes
     * @see Collator#setReorderCodes
     * @stable ICU 4.8
     */
    U_I18N_API virtual int32_t getReorderCodes(int32_t* dest,
                                               int32_t destCapacity,
                                               UErrorCode& status) const override;

    /**
     * Sets the ordering of scripts for this collator.
     * @param reorderCodes An array of script codes in the new order. This can be nullptr if the
     * length is also set to 0. An empty array will clear any reordering codes on the collator.
     * @param reorderCodesLength The length of reorderCodes.
     * @param status error code
     * @see ucol_setReorderCodes
     * @see Collator#getReorderCodes
     * @see Collator#getEquivalentReorderCodes
     * @stable ICU 4.8
     */
    U_I18N_API virtual void setReorderCodes(const int32_t* reorderCodes,
                                            int32_t reorderCodesLength,
                                            UErrorCode& status) override;

    /**
     * Implements ucol_strcollUTF8().
     * @internal
     */
    U_I18N_API virtual UCollationResult internalCompareUTF8(const char* left, int32_t leftLength,
                                                            const char* right, int32_t rightLength,
                                                            UErrorCode& errorCode) const override;

    /** Get the short definition string for a collator. This internal API harvests the collator's
     *  locale and the attribute set and produces a string that can be used for opening
     *  a collator with the same attributes using the ucol_openFromShortString API.
     *  This string will be normalized.
     *  The structure and the syntax of the string is defined in the "Naming collators"
     *  section of the users guide:
     *  https://unicode-org.github.io/icu/userguide/collation/concepts#collator-naming-scheme
     *  This function supports preflighting.
     *
     *  This is internal, and intended to be used with delegate converters.
     *
     *  @param locale a locale that will appear as a collators locale in the resulting
     *                short string definition. If nullptr, the locale will be harvested
     *                from the collator.
     *  @param buffer space to hold the resulting string
     *  @param capacity capacity of the buffer
     *  @param status for returning errors. All the preflighting errors are featured
     *  @return length of the resulting string
     *  @see ucol_openFromShortString
     *  @see ucol_normalizeShortDefinitionString
     *  @see ucol_getShortDefinitionString
     *  @internal
     */
    U_I18N_API virtual int32_t internalGetShortDefinitionString(const char* locale,
                                                                char* buffer,
                                                                int32_t capacity,
                                                                UErrorCode& status) const override;

    /**
     * Implements ucol_nextSortKeyPart().
     * @internal
     */
    U_I18N_API virtual int32_t internalNextSortKeyPart(UCharIterator* iter,
                                                       uint32_t state[2],
                                                       uint8_t* dest,
                                                       int32_t count,
                                                       UErrorCode& errorCode) const override;

    // Do not enclose the default constructor with #ifndef U_HIDE_INTERNAL_API
    /**
     * Only for use in ucol_openRules().
     * @internal
     */
    U_I18N_API RuleBasedCollator();

#ifndef U_HIDE_INTERNAL_API
    /**
     * Implements ucol_getLocaleByType().
     * Needed because the lifetime of the locale ID string must match that of the collator.
     * getLocale() returns a copy of a Locale, with minimal lifetime in a C wrapper.
     * @internal
     */
    U_I18N_API const char* internalGetLocaleID(ULocDataLocaleType type, UErrorCode& errorCode) const;

    /**
     * Implements ucol_getContractionsAndExpansions().
     * Gets this collator's sets of contraction strings and/or
     * characters and strings that map to multiple collation elements (expansions).
     * If addPrefixes is true, then contractions that are expressed as
     * prefix/pre-context rules are included.
     * @param contractions if not nullptr, the set to hold the contractions
     * @param expansions if not nullptr, the set to hold the expansions
     * @param addPrefixes include prefix contextual mappings
     * @param errorCode in/out ICU error code
     * @internal
     */
    U_I18N_API void internalGetContractionsAndExpansions(UnicodeSet* contractions,
                                                         UnicodeSet* expansions,
                                                         UBool addPrefixes,
                                                         UErrorCode& errorCode) const;

    /**
     * Adds the contractions that start with character c to the set.
     * Ignores prefixes. Used by AlphabeticIndex.
     * @internal
     */
    U_I18N_API void internalAddContractions(UChar32 c, UnicodeSet& set, UErrorCode& errorCode) const;

    /**
     * Implements from-rule constructors, and ucol_openRules().
     * @internal
     */
    U_I18N_API void internalBuildTailoring(const UnicodeString& rules,
                                           int32_t strength,
                                           UColAttributeValue decompositionMode,
                                           UParseError* outParseError,
                                           UnicodeString* outReason,
                                           UErrorCode& errorCode);

    /** @internal */
    static inline RuleBasedCollator *rbcFromUCollator(UCollator *uc) {
        return dynamic_cast<RuleBasedCollator *>(fromUCollator(uc));
    }
    /** @internal */
    static inline const RuleBasedCollator *rbcFromUCollator(const UCollator *uc) {
        return dynamic_cast<const RuleBasedCollator *>(fromUCollator(uc));
    }

    /**
     * Appends the CEs for the string to the vector.
     * @internal for tests & tools
     */
    U_I18N_API void internalGetCEs(const UnicodeString& str,
                                   UVector64& ces,
                                   UErrorCode& errorCode) const;
#endif  // U_HIDE_INTERNAL_API

protected:
   /**
    * Used internally by registration to define the requested and valid locales.
    * @param requestedLocale the requested locale
    * @param validLocale the valid locale
    * @param actualLocale the actual locale
    * @internal
    */
    virtual void setLocales(const Locale& requestedLocale, const Locale& validLocale, const Locale& actualLocale) override;

private:
    friend class CollationElementIterator;
    friend class Collator;

    RuleBasedCollator(const CollationCacheEntry *entry);

    /**
     * Enumeration of attributes that are relevant for short definition strings
     * (e.g., ucol_getShortDefinitionString()).
     * Effectively extends UColAttribute.
     */
    enum Attributes {
        ATTR_VARIABLE_TOP = UCOL_ATTRIBUTE_COUNT,
        ATTR_LIMIT
    };

    void adoptTailoring(CollationTailoring *t, UErrorCode &errorCode);

    // Both lengths must be <0 or else both must be >=0.
    UCollationResult doCompare(const char16_t *left, int32_t leftLength,
                               const char16_t *right, int32_t rightLength,
                               UErrorCode &errorCode) const;
    UCollationResult doCompare(const uint8_t *left, int32_t leftLength,
                               const uint8_t *right, int32_t rightLength,
                               UErrorCode &errorCode) const;

    void writeSortKey(const char16_t *s, int32_t length,
                      SortKeyByteSink &sink, UErrorCode &errorCode) const;

    void writeIdenticalLevel(const char16_t *s, const char16_t *limit,
                             SortKeyByteSink &sink, UErrorCode &errorCode) const;

    const CollationSettings &getDefaultSettings() const;

    void setAttributeDefault(int32_t attribute) {
        explicitlySetAttributes &= ~(static_cast<uint32_t>(1) << attribute);
    }
    void setAttributeExplicitly(int32_t attribute) {
        explicitlySetAttributes |= static_cast<uint32_t>(1) << attribute;
    }
    UBool attributeHasBeenSetExplicitly(int32_t attribute) const {
        // assert(0 <= attribute < ATTR_LIMIT);
        return (explicitlySetAttributes & (static_cast<uint32_t>(1) << attribute)) != 0;
    }

    /**
     * Tests whether a character is "unsafe" for use as a collation starting point.
     *
     * @param c code point or code unit
     * @return true if c is unsafe
     * @see CollationElementIterator#setOffset(int)
     */
    UBool isUnsafe(UChar32 c) const;

    static void U_CALLCONV computeMaxExpansions(const CollationTailoring *t, UErrorCode &errorCode);
    UBool initMaxExpansions(UErrorCode &errorCode) const;

    void setFastLatinOptions(CollationSettings &ownedSettings) const;

    const CollationData *data;
    const CollationSettings *settings;  // reference-counted
    const CollationTailoring *tailoring;  // alias of cacheEntry->tailoring
    const CollationCacheEntry *cacheEntry;  // reference-counted
    Locale validLocale;
    uint32_t explicitlySetAttributes;

    UBool actualLocaleIsSameAsValid;
};

U_NAMESPACE_END

#endif  // !UCONFIG_NO_COLLATION

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // TBLCOLL_H
