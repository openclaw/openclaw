// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (c) 1996-2015, International Business Machines Corporation and others.
* All Rights Reserved.
*******************************************************************************
*/

#ifndef UCOL_H
#define UCOL_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_COLLATION

#include "unicode/unorm.h"
#include "unicode/parseerr.h"
#include "unicode/uloc.h"
#include "unicode/uset.h"
#include "unicode/uscript.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Collator 
 *
 * <h2> Collator C API </h2>
 *
 * The C API for Collator performs locale-sensitive
 * string comparison. You use this service to build
 * searching and sorting routines for natural language text.
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
 * @see         UCollationResult
 * @see         UNormalizationMode
 * @see         UCollationStrength
 * @see         UCollationElements
 */

/** A collator.
*  For usage in C programs.
*/
struct UCollator;
/** structure representing a collator object instance 
 * @stable ICU 2.0
 */
typedef struct UCollator UCollator;


/**
 * UCOL_LESS is returned if source string is compared to be less than target
 * string in the ucol_strcoll() method.
 * UCOL_EQUAL is returned if source string is compared to be equal to target
 * string in the ucol_strcoll() method.
 * UCOL_GREATER is returned if source string is compared to be greater than
 * target string in the ucol_strcoll() method.
 * @see ucol_strcoll()
 * <p>
 * Possible values for a comparison result 
 * @stable ICU 2.0
 */
typedef enum {
  /** string a == string b */
  UCOL_EQUAL    = 0,
  /** string a > string b */
  UCOL_GREATER    = 1,
  /** string a < string b */
  UCOL_LESS    = -1
} UCollationResult ;


/** Enum containing attribute values for controlling collation behavior.
 * Here are all the allowable values. Not every attribute can take every value. The only
 * universal value is UCOL_DEFAULT, which resets the attribute value to the predefined  
 * value for that locale 
 * @stable ICU 2.0
 */
typedef enum {
  /** accepted by most attributes */
  UCOL_DEFAULT = -1,

  /** Primary collation strength */
  UCOL_PRIMARY = 0,
  /** Secondary collation strength */
  UCOL_SECONDARY = 1,
  /** Tertiary collation strength */
  UCOL_TERTIARY = 2,
  /** Default collation strength */
  UCOL_DEFAULT_STRENGTH = UCOL_TERTIARY,
  UCOL_CE_STRENGTH_LIMIT,
  /** Quaternary collation strength */
  UCOL_QUATERNARY=3,
  /** Identical collation strength */
  UCOL_IDENTICAL=15,
  UCOL_STRENGTH_LIMIT,

  /** Turn the feature off - works for UCOL_FRENCH_COLLATION, 
      UCOL_CASE_LEVEL, UCOL_HIRAGANA_QUATERNARY_MODE
      & UCOL_DECOMPOSITION_MODE*/
  UCOL_OFF = 16,
  /** Turn the feature on - works for UCOL_FRENCH_COLLATION, 
      UCOL_CASE_LEVEL, UCOL_HIRAGANA_QUATERNARY_MODE
      & UCOL_DECOMPOSITION_MODE*/
  UCOL_ON = 17,
  
  /** Valid for UCOL_ALTERNATE_HANDLING. Alternate handling will be shifted */
  UCOL_SHIFTED = 20,
  /** Valid for UCOL_ALTERNATE_HANDLING. Alternate handling will be non ignorable */
  UCOL_NON_IGNORABLE = 21,

  /** Valid for UCOL_CASE_FIRST - 
      lower case sorts before upper case */
  UCOL_LOWER_FIRST = 24,
  /** upper case sorts before lower case */
  UCOL_UPPER_FIRST = 25,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UColAttributeValue value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
  UCOL_ATTRIBUTE_VALUE_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} UColAttributeValue;

/**
 * Enum containing the codes for reordering segments of the collation table that are not script
 * codes. These reordering codes are to be used in conjunction with the script codes.
 * @see ucol_getReorderCodes
 * @see ucol_setReorderCodes
 * @see ucol_getEquivalentReorderCodes
 * @see UScriptCode
 * @stable ICU 4.8
 */
 typedef enum {
   /**
    * A special reordering code that is used to specify the default
    * reordering codes for a locale.
    * @stable ICU 4.8
    */   
    UCOL_REORDER_CODE_DEFAULT       = -1,
   /**
    * A special reordering code that is used to specify no reordering codes.
    * @stable ICU 4.8
    */   
    UCOL_REORDER_CODE_NONE          = USCRIPT_UNKNOWN,
   /**
    * A special reordering code that is used to specify all other codes used for
    * reordering except for the codes lised as UColReorderCode values and those
    * listed explicitly in a reordering.
    * @stable ICU 4.8
    */   
    UCOL_REORDER_CODE_OTHERS        = USCRIPT_UNKNOWN,
   /**
    * Characters with the space property.
    * This is equivalent to the rule value "space".
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_SPACE         = 0x1000,
   /**
    * The first entry in the enumeration of reordering groups. This is intended for use in
    * range checking and enumeration of the reorder codes.
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_FIRST         = UCOL_REORDER_CODE_SPACE,
   /**
    * Characters with the punctuation property.
    * This is equivalent to the rule value "punct".
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_PUNCTUATION   = 0x1001,
   /**
    * Characters with the symbol property.
    * This is equivalent to the rule value "symbol".
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_SYMBOL        = 0x1002,
   /**
    * Characters with the currency property.
    * This is equivalent to the rule value "currency".
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_CURRENCY      = 0x1003,
   /**
    * Characters with the digit property.
    * This is equivalent to the rule value "digit".
    * @stable ICU 4.8
    */    
    UCOL_REORDER_CODE_DIGIT         = 0x1004,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UColReorderCode value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UCOL_REORDER_CODE_LIMIT         = 0x1005
#endif  /* U_HIDE_DEPRECATED_API */
} UColReorderCode;

/**
 * Base letter represents a primary difference.  Set comparison
 * level to UCOL_PRIMARY to ignore secondary and tertiary differences.
 * Use this to set the strength of a Collator object.
 * Example of primary difference, "abc" &lt; "abd"
 * 
 * Diacritical differences on the same base letter represent a secondary
 * difference.  Set comparison level to UCOL_SECONDARY to ignore tertiary
 * differences. Use this to set the strength of a Collator object.
 * Example of secondary difference, "&auml;" >> "a".
 *
 * Uppercase and lowercase versions of the same character represents a
 * tertiary difference.  Set comparison level to UCOL_TERTIARY to include
 * all comparison differences. Use this to set the strength of a Collator
 * object.
 * Example of tertiary difference, "abc" &lt;&lt;&lt; "ABC".
 *
 * Two characters are considered "identical" when they have the same
 * unicode spellings.  UCOL_IDENTICAL.
 * For example, "&auml;" == "&auml;".
 *
 * UCollationStrength is also used to determine the strength of sort keys 
 * generated from UCollator objects
 * These values can be now found in the UColAttributeValue enum.
 * @stable ICU 2.0
 **/
typedef UColAttributeValue UCollationStrength;

/** Attributes that collation service understands. All the attributes can take UCOL_DEFAULT
 * value, as well as the values specific to each one. 
 * @stable ICU 2.0
 */
typedef enum {
     /** Attribute for direction of secondary weights - used in Canadian French.
      * Acceptable values are UCOL_ON, which results in secondary weights
      * being considered backwards and UCOL_OFF which treats secondary
      * weights in the order they appear.
      * @stable ICU 2.0
      */
     UCOL_FRENCH_COLLATION, 
     /** Attribute for handling variable elements.
      * Acceptable values are UCOL_NON_IGNORABLE
      * which treats all the codepoints with non-ignorable
      * primary weights in the same way,
      * and UCOL_SHIFTED which causes codepoints with primary
      * weights that are equal or below the variable top value
      * to be ignored on primary level and moved to the quaternary
      * level. The default setting in a Collator object depends on the
      * locale data loaded from the resources. For most locales, the
      * default is UCOL_NON_IGNORABLE, but for others, such as "th",
      * the default could be UCOL_SHIFTED.
      * @stable ICU 2.0
      */
     UCOL_ALTERNATE_HANDLING,
     /** Controls the ordering of upper and lower case letters.
      * Acceptable values are UCOL_OFF, which orders
      * upper and lower case letters in accordance to their tertiary
      * weights, UCOL_UPPER_FIRST which forces upper case letters to
      * sort before lower case letters, and UCOL_LOWER_FIRST which does
      * the opposite. The default setting in a Collator object depends on the
      * locale data loaded from the resources. For most locales, the
      * default is UCOL_OFF, but for others, such as "da" or "mt",
      * the default could be UCOL_UPPER.
      * @stable ICU 2.0
      */
     UCOL_CASE_FIRST,
     /** Controls whether an extra case level (positioned before the third
      * level) is generated or not. Acceptable values are UCOL_OFF,
      * when case level is not generated, and UCOL_ON which causes the case
      * level to be generated. Contents of the case level are affected by
      * the value of UCOL_CASE_FIRST attribute. A simple way to ignore
      * accent differences in a string is to set the strength to UCOL_PRIMARY
      * and enable case level. The default setting in a Collator object depends
      * on the locale data loaded from the resources.
      * @stable ICU 2.0
      */
     UCOL_CASE_LEVEL,
     /** Controls whether the normalization check and necessary normalizations
      * are performed. When set to UCOL_OFF no normalization check
      * is performed. The correctness of the result is guaranteed only if the
      * input data is in so-called FCD form (see users manual for more info).
      * When set to UCOL_ON, an incremental check is performed to see whether
      * the input data is in the FCD form. If the data is not in the FCD form,
      * incremental NFD normalization is performed. The default setting in a
      * Collator object depends on the locale data loaded from the resources.
      * For many locales, the default is UCOL_OFF, but for others, such as "hi"
      * "vi', or "bn", * the default could be UCOL_ON.
      * @stable ICU 2.0
      */
     UCOL_NORMALIZATION_MODE, 
     /** An alias for UCOL_NORMALIZATION_MODE attribute.
      * @stable ICU 2.0
      */
     UCOL_DECOMPOSITION_MODE = UCOL_NORMALIZATION_MODE,
     /** The strength attribute. Can be either UCOL_PRIMARY, UCOL_SECONDARY,
      * UCOL_TERTIARY, UCOL_QUATERNARY or UCOL_IDENTICAL. The usual strength
      * for most locales (except Japanese) is tertiary.
      *
      * Quaternary strength 
      * is useful when combined with shifted setting for alternate handling
      * attribute and for JIS X 4061 collation, when it is used to distinguish
      * between Katakana and Hiragana.
      * Otherwise, quaternary level
      * is affected only by the number of non-ignorable code points in
      * the string.
      *
      * Identical strength is rarely useful, as it amounts 
      * to codepoints of the NFD form of the string.
      * @stable ICU 2.0
      */
     UCOL_STRENGTH,  
#ifndef U_HIDE_DEPRECATED_API
     /** When turned on, this attribute positions Hiragana before all  
      * non-ignorables on quaternary level This is a sneaky way to produce JIS
      * sort order.
      *
      * This attribute was an implementation detail of the CLDR Japanese tailoring.
      * Since ICU 50, this attribute is not settable any more via API functions.
      * Since CLDR 25/ICU 53, explicit quaternary relations are used
      * to achieve the same Japanese sort order.
      *
      * @deprecated ICU 50 Implementation detail, cannot be set via API, was removed from implementation.
      */
     UCOL_HIRAGANA_QUATERNARY_MODE = UCOL_STRENGTH + 1,
#endif  /* U_HIDE_DEPRECATED_API */
     /**
      * When turned on, this attribute makes
      * substrings of digits sort according to their numeric values.
      *
      * This is a way to get '100' to sort AFTER '2'. Note that the longest
      * digit substring that can be treated as a single unit is
      * 254 digits (not counting leading zeros). If a digit substring is
      * longer than that, the digits beyond the limit will be treated as a
      * separate digit substring.
      *
      * A "digit" in this sense is a code point with General_Category=Nd,
      * which does not include circled numbers, roman numerals, etc.
      * Only a contiguous digit substring is considered, that is,
      * non-negative integers without separators.
      * There is no support for plus/minus signs, decimals, exponents, etc.
      *
      * @stable ICU 2.8
      */
     UCOL_NUMERIC_COLLATION = UCOL_STRENGTH + 2, 

    /* Do not conditionalize the following with #ifndef U_HIDE_DEPRECATED_API,
     * it is needed for layout of RuleBasedCollator object. */
#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UColAttribute value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
     UCOL_ATTRIBUTE_COUNT
#endif  // U_FORCE_HIDE_DEPRECATED_API
} UColAttribute;

/** Options for retrieving the rule string 
 *  @stable ICU 2.0
 */
typedef enum {
  /**
   * Retrieves the tailoring rules only.
   * Same as calling the version of getRules() without UColRuleOption.
   * @stable ICU 2.0
   */
  UCOL_TAILORING_ONLY, 
  /**
   * Retrieves the "UCA rules" concatenated with the tailoring rules.
   * The "UCA rules" are an <i>approximation</i> of the root collator's sort order.
   * They are almost never used or useful at runtime and can be removed from the data.
   * See https://unicode-org.github.io/icu/userguide/collation/customization#building-on-existing-locales
   * @stable ICU 2.0
   */
  UCOL_FULL_RULES 
} UColRuleOption ;

/**
 * Open a UCollator for comparing strings.
 *
 * For some languages, multiple collation types are available;
 * for example, "de@collation=phonebook".
 * Starting with ICU 54, collation attributes can be specified via locale keywords as well,
 * in the old locale extension syntax ("el@colCaseFirst=upper")
 * or in language tag syntax ("el-u-kf-upper").
 * See <a href="https://unicode-org.github.io/icu/userguide/collation/api">User Guide: Collation API</a>.
 *
 * The UCollator pointer is used in all the calls to the Collation 
 * service. After finished, collator must be disposed of by calling
 * {@link #ucol_close }.
 * @param loc The locale containing the required collation rules. 
 *            Special values for locales can be passed in - 
 *            if NULL is passed for the locale, the default locale
 *            collation rules will be used. If empty string ("") or
 *            "root" are passed, the root collator will be returned.
 * @param status A pointer to a UErrorCode to receive any errors
 * @return A pointer to a UCollator, or 0 if an error occurred.
 * @see ucol_openRules
 * @see ucol_clone
 * @see ucol_close
 * @stable ICU 2.0
 */
U_CAPI UCollator* U_EXPORT2 
ucol_open(const char *loc, UErrorCode *status);

/**
 * Produce a UCollator instance according to the rules supplied.
 * The rules are used to change the default ordering, defined in the
 * UCA in a process called tailoring. The resulting UCollator pointer
 * can be used in the same way as the one obtained by {@link #ucol_open }.
 * @param rules A string describing the collation rules. For the syntax
 *              of the rules please see users guide.
 * @param rulesLength The length of rules, or -1 if null-terminated.
 * @param normalizationMode The normalization mode: One of
 *             UCOL_OFF     (expect the text to not need normalization),
 *             UCOL_ON      (normalize), or
 *             UCOL_DEFAULT (set the mode according to the rules)
 * @param strength The collation strength; one of UCOL_PRIMARY, UCOL_SECONDARY,
 *                 UCOL_TERTIARY, UCOL_QUATERNARY, UCOL_IDENTICAL, UCOL_DEFAULT_STRENGTH.
 *                 If you want to set the strength via the rules,
 *                 then use UCOL_DEFAULT to not override that.
 * @param parseError  A pointer to UParseError to receive information about errors
 *                    occurred during parsing. This argument can currently be set
 *                    to NULL, but at users own risk. Please provide a real structure.
 * @param status A pointer to a UErrorCode to receive any errors
 * @return A pointer to a UCollator. It is not guaranteed that NULL be returned in case
 *         of error - please use status argument to check for errors.
 * @see ucol_open
 * @see ucol_clone
 * @see ucol_close
 * @stable ICU 2.0
 */
U_CAPI UCollator* U_EXPORT2 
ucol_openRules( const UChar        *rules,
                int32_t            rulesLength,
                UColAttributeValue normalizationMode,
                UCollationStrength strength,
                UParseError        *parseError,
                UErrorCode         *status);

#ifndef U_HIDE_DEPRECATED_API
/** 
 * Open a collator defined by a short form string.
 * The structure and the syntax of the string is defined in the "Naming collators"
 * section of the users guide: 
 * https://unicode-org.github.io/icu/userguide/collation/concepts#collator-naming-scheme
 * Attributes are overridden by the subsequent attributes. So, for "S2_S3", final
 * strength will be 3. 3066bis locale overrides individual locale parts.
 * The call to this function is equivalent to a call to ucol_open, followed by a 
 * series of calls to ucol_setAttribute and ucol_setVariableTop.
 * @param definition A short string containing a locale and a set of attributes. 
 *                   Attributes not explicitly mentioned are left at the default
 *                   state for a locale.
 * @param parseError if not NULL, structure that will get filled with error's pre
 *                   and post context in case of error.
 * @param forceDefaults if false, the settings that are the same as the collator 
 *                   default settings will not be applied (for example, setting
 *                   French secondary on a French collator would not be executed). 
 *                   If true, all the settings will be applied regardless of the 
 *                   collator default value. If the definition
 *                   strings are to be cached, should be set to false.
 * @param status     Error code. Apart from regular error conditions connected to 
 *                   instantiating collators (like out of memory or similar), this
 *                   API will return an error if an invalid attribute or attribute/value
 *                   combination is specified.
 * @return           A pointer to a UCollator or 0 if an error occurred (including an 
 *                   invalid attribute).
 * @see ucol_open
 * @see ucol_setAttribute
 * @see ucol_setVariableTop
 * @see ucol_getShortDefinitionString
 * @see ucol_normalizeShortDefinitionString
 * @deprecated ICU 54 Use ucol_open() with language tag collation keywords instead.
 */
U_DEPRECATED UCollator* U_EXPORT2
ucol_openFromShortString( const char *definition,
                          UBool forceDefaults,
                          UParseError *parseError,
                          UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */

#ifndef U_HIDE_DEPRECATED_API
/**
 * Get a set containing the contractions defined by the collator. The set includes
 * both the root collator's contractions and the contractions defined by the collator. This set
 * will contain only strings. If a tailoring explicitly suppresses contractions from 
 * the root collator (like Russian), removed contractions will not be in the resulting set.
 * @param coll collator 
 * @param conts the set to hold the result. It gets emptied before
 *              contractions are added. 
 * @param status to hold the error code
 * @return the size of the contraction set
 *
 * @deprecated ICU 3.4, use ucol_getContractionsAndExpansions instead
 */
U_DEPRECATED int32_t U_EXPORT2
ucol_getContractions( const UCollator *coll,
                  USet *conts,
                  UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */

/**
 * Get a set containing the expansions defined by the collator. The set includes
 * both the root collator's expansions and the expansions defined by the tailoring
 * @param coll collator
 * @param contractions if not NULL, the set to hold the contractions
 * @param expansions if not NULL, the set to hold the expansions
 * @param addPrefixes add the prefix contextual elements to contractions
 * @param status to hold the error code
 *
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ucol_getContractionsAndExpansions( const UCollator *coll,
                  USet *contractions, USet *expansions,
                  UBool addPrefixes, UErrorCode *status);

/** 
 * Close a UCollator.
 * Once closed, a UCollator should not be used. Every open collator should
 * be closed. Otherwise, a memory leak will result.
 * @param coll The UCollator to close.
 * @see ucol_open
 * @see ucol_openRules
 * @see ucol_clone
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_close(UCollator *coll);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUCollatorPointer
 * "Smart pointer" class, closes a UCollator via ucol_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUCollatorPointer, UCollator, ucol_close);

U_NAMESPACE_END

#endif

/**
 * Compare two strings.
 * The strings will be compared using the options already specified.
 * @param coll The UCollator containing the comparison rules.
 * @param source The source string.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param target The target string.
 * @param targetLength The length of target, or -1 if null-terminated.
 * @return The result of comparing the strings; one of UCOL_EQUAL,
 * UCOL_GREATER, UCOL_LESS
 * @see ucol_greater
 * @see ucol_greaterOrEqual
 * @see ucol_equal
 * @stable ICU 2.0
 */
U_CAPI UCollationResult U_EXPORT2 
ucol_strcoll(    const    UCollator    *coll,
        const    UChar        *source,
        int32_t            sourceLength,
        const    UChar        *target,
        int32_t            targetLength);

/** 
* Compare two strings in UTF-8. 
* The strings will be compared using the options already specified. 
* Note: When input string contains malformed a UTF-8 byte sequence, 
* this function treats these bytes as REPLACEMENT CHARACTER (U+FFFD).
* @param coll The UCollator containing the comparison rules. 
* @param source The source UTF-8 string. 
* @param sourceLength The length of source, or -1 if null-terminated. 
* @param target The target UTF-8 string. 
* @param targetLength The length of target, or -1 if null-terminated. 
* @param status A pointer to a UErrorCode to receive any errors 
* @return The result of comparing the strings; one of UCOL_EQUAL, 
* UCOL_GREATER, UCOL_LESS 
* @see ucol_greater 
* @see ucol_greaterOrEqual 
* @see ucol_equal 
* @stable ICU 50 
*/ 
U_CAPI UCollationResult U_EXPORT2
ucol_strcollUTF8(
        const UCollator *coll,
        const char      *source,
        int32_t         sourceLength,
        const char      *target,
        int32_t         targetLength,
        UErrorCode      *status);

/**
 * Determine if one string is greater than another.
 * This function is equivalent to {@link #ucol_strcoll } == UCOL_GREATER
 * @param coll The UCollator containing the comparison rules.
 * @param source The source string.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param target The target string.
 * @param targetLength The length of target, or -1 if null-terminated.
 * @return true if source is greater than target, false otherwise.
 * @see ucol_strcoll
 * @see ucol_greaterOrEqual
 * @see ucol_equal
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucol_greater(const UCollator *coll,
             const UChar     *source, int32_t sourceLength,
             const UChar     *target, int32_t targetLength);

/**
 * Determine if one string is greater than or equal to another.
 * This function is equivalent to {@link #ucol_strcoll } != UCOL_LESS
 * @param coll The UCollator containing the comparison rules.
 * @param source The source string.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param target The target string.
 * @param targetLength The length of target, or -1 if null-terminated.
 * @return true if source is greater than or equal to target, false otherwise.
 * @see ucol_strcoll
 * @see ucol_greater
 * @see ucol_equal
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucol_greaterOrEqual(const UCollator *coll,
                    const UChar     *source, int32_t sourceLength,
                    const UChar     *target, int32_t targetLength);

/**
 * Compare two strings for equality.
 * This function is equivalent to {@link #ucol_strcoll } == UCOL_EQUAL
 * @param coll The UCollator containing the comparison rules.
 * @param source The source string.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param target The target string.
 * @param targetLength The length of target, or -1 if null-terminated.
 * @return true if source is equal to target, false otherwise
 * @see ucol_strcoll
 * @see ucol_greater
 * @see ucol_greaterOrEqual
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucol_equal(const UCollator *coll,
           const UChar     *source, int32_t sourceLength,
           const UChar     *target, int32_t targetLength);

/**
 * Compare two UTF-8 encoded strings.
 * The strings will be compared using the options already specified.
 * @param coll The UCollator containing the comparison rules.
 * @param sIter The source string iterator.
 * @param tIter The target string iterator.
 * @return The result of comparing the strings; one of UCOL_EQUAL,
 * UCOL_GREATER, UCOL_LESS
 * @param status A pointer to a UErrorCode to receive any errors
 * @see ucol_strcoll
 * @stable ICU 2.6
 */
U_CAPI UCollationResult U_EXPORT2 
ucol_strcollIter(  const    UCollator    *coll,
                  UCharIterator *sIter,
                  UCharIterator *tIter,
                  UErrorCode *status);

/**
 * Get the collation strength used in a UCollator.
 * The strength influences how strings are compared.
 * @param coll The UCollator to query.
 * @return The collation strength; one of UCOL_PRIMARY, UCOL_SECONDARY,
 * UCOL_TERTIARY, UCOL_QUATERNARY, UCOL_IDENTICAL
 * @see ucol_setStrength
 * @stable ICU 2.0
 */
U_CAPI UCollationStrength U_EXPORT2 
ucol_getStrength(const UCollator *coll);

/**
 * Set the collation strength used in a UCollator.
 * The strength influences how strings are compared.
 * @param coll The UCollator to set.
 * @param strength The desired collation strength; one of UCOL_PRIMARY, 
 * UCOL_SECONDARY, UCOL_TERTIARY, UCOL_QUATERNARY, UCOL_IDENTICAL, UCOL_DEFAULT
 * @see ucol_getStrength
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_setStrength(UCollator *coll,
                 UCollationStrength strength);

/**
 * Retrieves the reordering codes for this collator.
 * These reordering codes are a combination of UScript codes and UColReorderCode entries.
 * @param coll The UCollator to query.
 * @param dest The array to fill with the script ordering.
 * @param destCapacity The length of dest. If it is 0, then dest may be NULL and the function 
 * will only return the length of the result without writing any codes (pre-flighting).
 * @param pErrorCode Must be a valid pointer to an error code value, which must not indicate a 
 * failure before the function call.
 * @return The number of reordering codes written to the dest array.
 * @see ucol_setReorderCodes
 * @see ucol_getEquivalentReorderCodes
 * @see UScriptCode
 * @see UColReorderCode
 * @stable ICU 4.8
 */
U_CAPI int32_t U_EXPORT2 
ucol_getReorderCodes(const UCollator* coll,
                    int32_t* dest,
                    int32_t destCapacity,
                    UErrorCode *pErrorCode);
/** 
 * Sets the reordering codes for this collator.
 * Collation reordering allows scripts and some other groups of characters
 * to be moved relative to each other. This reordering is done on top of
 * the DUCET/CLDR standard collation order. Reordering can specify groups to be placed 
 * at the start and/or the end of the collation order. These groups are specified using
 * UScript codes and UColReorderCode entries.
 *
 * <p>By default, reordering codes specified for the start of the order are placed in the 
 * order given after several special non-script blocks. These special groups of characters
 * are space, punctuation, symbol, currency, and digit. These special groups are represented with
 * UColReorderCode entries. Script groups can be intermingled with 
 * these special non-script groups if those special groups are explicitly specified in the reordering.
 *
 * <p>The special code OTHERS stands for any script that is not explicitly 
 * mentioned in the list of reordering codes given. Anything that is after OTHERS
 * will go at the very end of the reordering in the order given.
 *
 * <p>The special reorder code DEFAULT will reset the reordering for this collator
 * to the default for this collator. The default reordering may be the DUCET/CLDR order or may be a reordering that
 * was specified when this collator was created from resource data or from rules. The 
 * DEFAULT code <b>must</b> be the sole code supplied when it is used.
 * If not, then U_ILLEGAL_ARGUMENT_ERROR will be set.
 *
 * <p>The special reorder code NONE will remove any reordering for this collator.
 * The result of setting no reordering will be to have the DUCET/CLDR ordering used. The 
 * NONE code <b>must</b> be the sole code supplied when it is used.
 *
 * @param coll The UCollator to set.
 * @param reorderCodes An array of script codes in the new order. This can be NULL if the 
 * length is also set to 0. An empty array will clear any reordering codes on the collator.
 * @param reorderCodesLength The length of reorderCodes.
 * @param pErrorCode Must be a valid pointer to an error code value, which must not indicate a
 * failure before the function call.
 * @see ucol_getReorderCodes
 * @see ucol_getEquivalentReorderCodes
 * @see UScriptCode
 * @see UColReorderCode
 * @stable ICU 4.8
 */ 
U_CAPI void U_EXPORT2 
ucol_setReorderCodes(UCollator* coll,
                    const int32_t* reorderCodes,
                    int32_t reorderCodesLength,
                    UErrorCode *pErrorCode);

/**
 * Retrieves the reorder codes that are grouped with the given reorder code. Some reorder
 * codes will be grouped and must reorder together.
 * Beginning with ICU 55, scripts only reorder together if they are primary-equal,
 * for example Hiragana and Katakana.
 *
 * @param reorderCode The reorder code to determine equivalence for.
 * @param dest The array to fill with the script ordering.
 * @param destCapacity The length of dest. If it is 0, then dest may be NULL and the function
 * will only return the length of the result without writing any codes (pre-flighting).
 * @param pErrorCode Must be a valid pointer to an error code value, which must not indicate 
 * a failure before the function call.
 * @return The number of reordering codes written to the dest array.
 * @see ucol_setReorderCodes
 * @see ucol_getReorderCodes
 * @see UScriptCode
 * @see UColReorderCode
 * @stable ICU 4.8
 */
U_CAPI int32_t U_EXPORT2 
ucol_getEquivalentReorderCodes(int32_t reorderCode,
                    int32_t* dest,
                    int32_t destCapacity,
                    UErrorCode *pErrorCode);

/**
 * Get the display name for a UCollator.
 * The display name is suitable for presentation to a user.
 * @param objLoc The locale of the collator in question.
 * @param dispLoc The locale for display.
 * @param result A pointer to a buffer to receive the attribute.
 * @param resultLength The maximum size of result.
 * @param status A pointer to a UErrorCode to receive any errors
 * @return The total buffer size needed; if greater than resultLength,
 * the output was truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_getDisplayName(    const    char        *objLoc,
            const    char        *dispLoc,
            UChar             *result,
            int32_t         resultLength,
            UErrorCode        *status);

/**
 * Get a locale for which collation rules are available.
 * A UCollator in a locale returned by this function will perform the correct
 * collation for the locale.
 * @param localeIndex The index of the desired locale.
 * @return A locale for which collation rules are available, or 0 if none.
 * @see ucol_countAvailable
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2 
ucol_getAvailable(int32_t localeIndex);

/**
 * Determine how many locales have collation rules available.
 * This function is most useful as determining the loop ending condition for
 * calls to {@link #ucol_getAvailable }.
 * @return The number of locales for which collation rules are available.
 * @see ucol_getAvailable
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_countAvailable(void);

#if !UCONFIG_NO_SERVICE
/**
 * Create a string enumerator of all locales for which a valid
 * collator may be opened.
 * @param status input-output error code
 * @return a string enumeration over locale strings. The caller is
 * responsible for closing the result.
 * @stable ICU 3.0
 */
U_CAPI UEnumeration* U_EXPORT2
ucol_openAvailableLocales(UErrorCode *status);
#endif

/**
 * Create a string enumerator of all possible keywords that are relevant to
 * collation. At this point, the only recognized keyword for this
 * service is "collation".
 * @param status input-output error code
 * @return a string enumeration over locale strings. The caller is
 * responsible for closing the result.
 * @stable ICU 3.0
 */
U_CAPI UEnumeration* U_EXPORT2
ucol_getKeywords(UErrorCode *status);

/**
 * Given a keyword, create a string enumeration of all values
 * for that keyword that are currently in use.
 * @param keyword a particular keyword as enumerated by
 * ucol_getKeywords. If any other keyword is passed in, *status is set
 * to U_ILLEGAL_ARGUMENT_ERROR.
 * @param status input-output error code
 * @return a string enumeration over collation keyword values, or NULL
 * upon error. The caller is responsible for closing the result.
 * @stable ICU 3.0
 */
U_CAPI UEnumeration* U_EXPORT2
ucol_getKeywordValues(const char *keyword, UErrorCode *status);

/**
 * Given a key and a locale, returns an array of string values in a preferred
 * order that would make a difference. These are all and only those values where
 * the open (creation) of the service with the locale formed from the input locale
 * plus input keyword and that value has different behavior than creation with the
 * input locale alone.
 * @param key           one of the keys supported by this service.  For now, only
 *                      "collation" is supported.
 * @param locale        the locale
 * @param commonlyUsed  if set to true it will return only commonly used values
 *                      with the given locale in preferred order.  Otherwise,
 *                      it will return all the available values for the locale.
 * @param status error status
 * @return a string enumeration over keyword values for the given key and the locale.
 * @stable ICU 4.2
 */
U_CAPI UEnumeration* U_EXPORT2
ucol_getKeywordValuesForLocale(const char* key,
                               const char* locale,
                               UBool commonlyUsed,
                               UErrorCode* status);

/**
 * Return the functionally equivalent locale for the specified
 * input locale, with respect to given keyword, for the
 * collation service. If two different input locale + keyword
 * combinations produce the same result locale, then collators
 * instantiated for these two different input locales will behave
 * equivalently. The converse is not always true; two collators
 * may in fact be equivalent, but return different results, due to
 * internal details. The return result has no other meaning than
 * that stated above, and implies nothing as to the relationship
 * between the two locales. This is intended for use by
 * applications who wish to cache collators, or otherwise reuse
 * collators when possible. The functional equivalent may change
 * over time. For more information, please see the <a
 * href="https://unicode-org.github.io/icu/userguide/locale#locales-and-services">
 * Locales and Services</a> section of the ICU User Guide.
 * @param result fillin for the functionally equivalent result locale
 * @param resultCapacity capacity of the fillin buffer
 * @param keyword a particular keyword as enumerated by
 * ucol_getKeywords.
 * @param locale the specified input locale
 * @param isAvailable if non-NULL, pointer to a fillin parameter that
 * on return indicates whether the specified input locale was 'available'
 * to the collation service. A locale is defined as 'available' if it
 * physically exists within the collation locale data.
 * @param status pointer to input-output error code
 * @return the actual buffer size needed for the locale. If greater
 * than resultCapacity, the returned full name will be truncated and
 * an error code will be returned.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
ucol_getFunctionalEquivalent(char* result, int32_t resultCapacity,
                             const char* keyword, const char* locale,
                             UBool* isAvailable, UErrorCode* status);

/**
 * Get the collation tailoring rules from a UCollator.
 * The rules will follow the rule syntax.
 * @param coll The UCollator to query.
 * @param length 
 * @return The collation tailoring rules.
 * @stable ICU 2.0
 */
U_CAPI const UChar* U_EXPORT2 
ucol_getRules(    const    UCollator    *coll, 
        int32_t            *length);

#ifndef U_HIDE_DEPRECATED_API
/** Get the short definition string for a collator. This API harvests the collator's
 *  locale and the attribute set and produces a string that can be used for opening 
 *  a collator with the same attributes using the ucol_openFromShortString API.
 *  This string will be normalized.
 *  The structure and the syntax of the string is defined in the "Naming collators"
 *  section of the users guide: 
 *  https://unicode-org.github.io/icu/userguide/collation/concepts#collator-naming-scheme
 *  This API supports preflighting.
 *  @param coll a collator
 *  @param locale a locale that will appear as a collators locale in the resulting
 *                short string definition. If NULL, the locale will be harvested 
 *                from the collator.
 *  @param buffer space to hold the resulting string
 *  @param capacity capacity of the buffer
 *  @param status for returning errors. All the preflighting errors are featured
 *  @return length of the resulting string
 *  @see ucol_openFromShortString
 *  @see ucol_normalizeShortDefinitionString
 *  @deprecated ICU 54
 */
U_DEPRECATED int32_t U_EXPORT2
ucol_getShortDefinitionString(const UCollator *coll,
                              const char *locale,
                              char *buffer,
                              int32_t capacity,
                              UErrorCode *status);

/** Verifies and normalizes short definition string.
 *  Normalized short definition string has all the option sorted by the argument name,
 *  so that equivalent definition strings are the same. 
 *  This API supports preflighting.
 *  @param source definition string
 *  @param destination space to hold the resulting string
 *  @param capacity capacity of the buffer
 *  @param parseError if not NULL, structure that will get filled with error's pre
 *                   and post context in case of error.
 *  @param status     Error code. This API will return an error if an invalid attribute 
 *                    or attribute/value combination is specified. All the preflighting 
 *                    errors are also featured
 *  @return length of the resulting normalized string.
 *
 *  @see ucol_openFromShortString
 *  @see ucol_getShortDefinitionString
 * 
 *  @deprecated ICU 54
 */
U_DEPRECATED int32_t U_EXPORT2
ucol_normalizeShortDefinitionString(const char *source,
                                    char *destination,
                                    int32_t capacity,
                                    UParseError *parseError,
                                    UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */


/**
 * Get a sort key for a string from a UCollator.
 * Sort keys may be compared using <TT>strcmp</TT>.
 *
 * Note that sort keys are often less efficient than simply doing comparison.  
 * For more details, see the ICU User Guide.
 *
 * Like ICU functions that write to an output buffer, the buffer contents
 * is undefined if the buffer capacity (resultLength parameter) is too small.
 * Unlike ICU functions that write a string to an output buffer,
 * the terminating zero byte is counted in the sort key length.
 * @param coll The UCollator containing the collation rules.
 * @param source The string to transform.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param result A pointer to a buffer to receive the attribute.
 * @param resultLength The maximum size of result.
 * @return The size needed to fully store the sort key.
 *      If there was an internal error generating the sort key,
 *      a zero value is returned.
 * @see ucol_keyHashCode
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_getSortKey(const    UCollator    *coll,
        const    UChar        *source,
        int32_t        sourceLength,
        uint8_t        *result,
        int32_t        resultLength);


/** Gets the next count bytes of a sort key. Caller needs
 *  to preserve state array between calls and to provide
 *  the same type of UCharIterator set with the same string.
 *  The destination buffer provided must be big enough to store
 *  the number of requested bytes.
 *
 *  The generated sort key may or may not be compatible with
 *  sort keys generated using ucol_getSortKey().
 *  @param coll The UCollator containing the collation rules.
 *  @param iter UCharIterator containing the string we need 
 *              the sort key to be calculated for.
 *  @param state Opaque state of sortkey iteration.
 *  @param dest Buffer to hold the resulting sortkey part
 *  @param count number of sort key bytes required.
 *  @param status error code indicator.
 *  @return the actual number of bytes of a sortkey. It can be
 *          smaller than count if we have reached the end of 
 *          the sort key.
 *  @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2 
ucol_nextSortKeyPart(const UCollator *coll,
                     UCharIterator *iter,
                     uint32_t state[2],
                     uint8_t *dest, int32_t count,
                     UErrorCode *status);

/** enum that is taken by ucol_getBound API 
 * See below for explanation                
 * do not change the values assigned to the 
 * members of this enum. Underlying code    
 * depends on them having these numbers     
 * @stable ICU 2.0
 */
typedef enum {
  /** lower bound */
  UCOL_BOUND_LOWER = 0,
  /** upper bound that will match strings of exact size */
  UCOL_BOUND_UPPER = 1,
  /** upper bound that will match all the strings that have the same initial substring as the given string */
  UCOL_BOUND_UPPER_LONG = 2,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UColBoundMode value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UCOL_BOUND_VALUE_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} UColBoundMode;

/**
 * Produce a bound for a given sortkey and a number of levels.
 * Return value is always the number of bytes needed, regardless of 
 * whether the result buffer was big enough or even valid.<br>
 * Resulting bounds can be used to produce a range of strings that are
 * between upper and lower bounds. For example, if bounds are produced
 * for a sortkey of string "smith", strings between upper and lower 
 * bounds with one level would include "Smith", "SMITH", "sMiTh".<br>
 * There are two upper bounds that can be produced. If UCOL_BOUND_UPPER
 * is produced, strings matched would be as above. However, if bound
 * produced using UCOL_BOUND_UPPER_LONG is used, the above example will
 * also match "Smithsonian" and similar.<br>
 * For more on usage, see example in cintltst/capitst.c in procedure
 * TestBounds.
 * Sort keys may be compared using <TT>strcmp</TT>.
 * @param source The source sortkey.
 * @param sourceLength The length of source, or -1 if null-terminated. 
 *                     (If an unmodified sortkey is passed, it is always null 
 *                      terminated).
 * @param boundType Type of bound required. It can be UCOL_BOUND_LOWER, which 
 *                  produces a lower inclusive bound, UCOL_BOUND_UPPER, that 
 *                  produces upper bound that matches strings of the same length 
 *                  or UCOL_BOUND_UPPER_LONG that matches strings that have the 
 *                  same starting substring as the source string.
 * @param noOfLevels  Number of levels required in the resulting bound (for most 
 *                    uses, the recommended value is 1). See users guide for 
 *                    explanation on number of levels a sortkey can have.
 * @param result A pointer to a buffer to receive the resulting sortkey.
 * @param resultLength The maximum size of result.
 * @param status Used for returning error code if something went wrong. If the 
 *               number of levels requested is higher than the number of levels
 *               in the source key, a warning (U_SORT_KEY_TOO_SHORT_WARNING) is 
 *               issued.
 * @return The size needed to fully store the bound. 
 * @see ucol_keyHashCode
 * @stable ICU 2.1
 */
U_CAPI int32_t U_EXPORT2 
ucol_getBound(const uint8_t       *source,
        int32_t             sourceLength,
        UColBoundMode       boundType,
        uint32_t            noOfLevels,
        uint8_t             *result,
        int32_t             resultLength,
        UErrorCode          *status);
        
/**
 * Gets the version information for a Collator. Version is currently
 * an opaque 32-bit number which depends, among other things, on major
 * versions of the collator tailoring and UCA.
 * @param coll The UCollator to query.
 * @param info the version # information, the result will be filled in
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucol_getVersion(const UCollator* coll, UVersionInfo info);

/**
 * Gets the UCA version information for a Collator. Version is the
 * UCA version number (3.1.1, 4.0).
 * @param coll The UCollator to query.
 * @param info the version # information, the result will be filled in
 * @stable ICU 2.8
 */
U_CAPI void U_EXPORT2
ucol_getUCAVersion(const UCollator* coll, UVersionInfo info);

/**
 * Merges two sort keys. The levels are merged with their corresponding counterparts
 * (primaries with primaries, secondaries with secondaries etc.). Between the values
 * from the same level a separator is inserted.
 *
 * This is useful, for example, for combining sort keys from first and last names
 * to sort such pairs.
 * See http://www.unicode.org/reports/tr10/#Merging_Sort_Keys
 *
 * The recommended way to achieve "merged" sorting is by
 * concatenating strings with U+FFFE between them.
 * The concatenation has the same sort order as the merged sort keys,
 * but merge(getSortKey(str1), getSortKey(str2)) may differ from getSortKey(str1 + '\\uFFFE' + str2).
 * Using strings with U+FFFE may yield shorter sort keys.
 *
 * For details about Sort Key Features see
 * https://unicode-org.github.io/icu/userguide/collation/api#sort-key-features
 *
 * It is possible to merge multiple sort keys by consecutively merging
 * another one with the intermediate result.
 *
 * The length of the merge result is the sum of the lengths of the input sort keys.
 *
 * Example (uncompressed):
 * <pre>191B1D 01 050505 01 910505 00
 * 1F2123 01 050505 01 910505 00</pre>
 * will be merged as 
 * <pre>191B1D 02 1F2123 01 050505 02 050505 01 910505 02 910505 00</pre>
 *
 * If the destination buffer is not big enough, then its contents are undefined.
 * If any of source lengths are zero or any of the source pointers are NULL/undefined,
 * the result is of size zero.
 *
 * @param src1 the first sort key
 * @param src1Length the length of the first sort key, including the zero byte at the end;
 *        can be -1 if the function is to find the length
 * @param src2 the second sort key
 * @param src2Length the length of the second sort key, including the zero byte at the end;
 *        can be -1 if the function is to find the length
 * @param dest the buffer where the merged sort key is written,
 *        can be NULL if destCapacity==0
 * @param destCapacity the number of bytes in the dest buffer
 * @return the length of the merged sort key, src1Length+src2Length;
 *         can be larger than destCapacity, or 0 if an error occurs (only for illegal arguments),
 *         in which cases the contents of dest is undefined
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucol_mergeSortkeys(const uint8_t *src1, int32_t src1Length,
                   const uint8_t *src2, int32_t src2Length,
                   uint8_t *dest, int32_t destCapacity);

/**
 * Universal attribute setter
 * @param coll collator which attributes are to be changed
 * @param attr attribute type 
 * @param value attribute value
 * @param status to indicate whether the operation went on smoothly or there were errors
 * @see UColAttribute
 * @see UColAttributeValue
 * @see ucol_getAttribute
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucol_setAttribute(UCollator *coll, UColAttribute attr, UColAttributeValue value, UErrorCode *status);

/**
 * Universal attribute getter
 * @param coll collator which attributes are to be changed
 * @param attr attribute type
 * @return attribute value
 * @param status to indicate whether the operation went on smoothly or there were errors
 * @see UColAttribute
 * @see UColAttributeValue
 * @see ucol_setAttribute
 * @stable ICU 2.0
 */
U_CAPI UColAttributeValue  U_EXPORT2 
ucol_getAttribute(const UCollator *coll, UColAttribute attr, UErrorCode *status);

/**
 * Sets the variable top to the top of the specified reordering group.
 * The variable top determines the highest-sorting character
 * which is affected by UCOL_ALTERNATE_HANDLING.
 * If that attribute is set to UCOL_NON_IGNORABLE, then the variable top has no effect.
 * @param coll the collator
 * @param group one of UCOL_REORDER_CODE_SPACE, UCOL_REORDER_CODE_PUNCTUATION,
 *              UCOL_REORDER_CODE_SYMBOL, UCOL_REORDER_CODE_CURRENCY;
 *              or UCOL_REORDER_CODE_DEFAULT to restore the default max variable group
 * @param pErrorCode Standard ICU error code. Its input value must
 *                   pass the U_SUCCESS() test, or else the function returns
 *                   immediately. Check for U_FAILURE() on output or use with
 *                   function chaining. (See User Guide for details.)
 * @see ucol_getMaxVariable
 * @stable ICU 53
 */
U_CAPI void U_EXPORT2
ucol_setMaxVariable(UCollator *coll, UColReorderCode group, UErrorCode *pErrorCode);

/**
 * Returns the maximum reordering group whose characters are affected by UCOL_ALTERNATE_HANDLING.
 * @param coll the collator
 * @return the maximum variable reordering group.
 * @see ucol_setMaxVariable
 * @stable ICU 53
 */
U_CAPI UColReorderCode U_EXPORT2
ucol_getMaxVariable(const UCollator *coll);

#ifndef U_HIDE_DEPRECATED_API
/**
 * Sets the variable top to the primary weight of the specified string.
 *
 * Beginning with ICU 53, the variable top is pinned to
 * the top of one of the supported reordering groups,
 * and it must not be beyond the last of those groups.
 * See ucol_setMaxVariable().
 * @param coll the collator
 * @param varTop one or more (if contraction) UChars to which the variable top should be set
 * @param len length of variable top string. If -1 it is considered to be zero terminated.
 * @param status error code. If error code is set, the return value is undefined.
 *               Errors set by this function are:<br>
 *    U_CE_NOT_FOUND_ERROR if more than one character was passed and there is no such contraction<br>
 *    U_ILLEGAL_ARGUMENT_ERROR if the variable top is beyond
 *    the last reordering group supported by ucol_setMaxVariable()
 * @return variable top primary weight
 * @see ucol_getVariableTop
 * @see ucol_restoreVariableTop
 * @deprecated ICU 53 Call ucol_setMaxVariable() instead.
 */
U_DEPRECATED uint32_t U_EXPORT2 
ucol_setVariableTop(UCollator *coll, 
                    const UChar *varTop, int32_t len, 
                    UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */

/** 
 * Gets the variable top value of a Collator. 
 * @param coll collator which variable top needs to be retrieved
 * @param status error code (not changed by function). If error code is set, 
 *               the return value is undefined.
 * @return the variable top primary weight
 * @see ucol_getMaxVariable
 * @see ucol_setVariableTop
 * @see ucol_restoreVariableTop
 * @stable ICU 2.0
 */
U_CAPI uint32_t U_EXPORT2 ucol_getVariableTop(const UCollator *coll, UErrorCode *status);

#ifndef U_HIDE_DEPRECATED_API
/**
 * Sets the variable top to the specified primary weight.
 *
 * Beginning with ICU 53, the variable top is pinned to
 * the top of one of the supported reordering groups,
 * and it must not be beyond the last of those groups.
 * See ucol_setMaxVariable().
 * @param coll collator to be set
 * @param varTop primary weight, as returned by ucol_setVariableTop or ucol_getVariableTop
 * @param status error code
 * @see ucol_getVariableTop
 * @see ucol_setVariableTop
 * @deprecated ICU 53 Call ucol_setMaxVariable() instead.
 */
U_DEPRECATED void U_EXPORT2 
ucol_restoreVariableTop(UCollator *coll, const uint32_t varTop, UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */

/**
 * Thread safe cloning operation. The result is a clone of a given collator.
 * @param coll collator to be cloned
 * @param status to indicate whether the operation went on smoothly or there were errors
 * @return pointer to the new clone
 * @see ucol_open
 * @see ucol_openRules
 * @see ucol_close
 * @stable ICU 71
 */
U_CAPI UCollator* U_EXPORT2 ucol_clone(const UCollator *coll, UErrorCode *status);

#ifndef U_HIDE_DEPRECATED_API

/**
 * Thread safe cloning operation. The result is a clone of a given collator.
 * @param coll collator to be cloned
 * @param stackBuffer <em>Deprecated functionality as of ICU 52, use NULL.</em><br>
 * user allocated space for the new clone. 
 * If NULL new memory will be allocated. 
 *  If buffer is not large enough, new memory will be allocated.
 *  Clients can use the U_COL_SAFECLONE_BUFFERSIZE.
 * @param pBufferSize <em>Deprecated functionality as of ICU 52, use NULL or 1.</em><br>
 *  pointer to size of allocated space. 
 *  If *pBufferSize == 0, a sufficient size for use in cloning will 
 *  be returned ('pre-flighting')
 *  If *pBufferSize is not enough for a stack-based safe clone, 
 *  new memory will be allocated.
 * @param status to indicate whether the operation went on smoothly or there were errors
 *    An informational status value, U_SAFECLONE_ALLOCATED_ERROR, is used
 * if pBufferSize != NULL and any allocations were necessary
 * @return pointer to the new clone
 * @see ucol_open
 * @see ucol_openRules
 * @see ucol_close
 * @deprecated ICU 71 Use ucol_clone() instead.
 */
U_DEPRECATED UCollator* U_EXPORT2
ucol_safeClone(const UCollator *coll,
               void            *stackBuffer,
               int32_t         *pBufferSize,
               UErrorCode      *status);


/** default memory size for the new clone.
 * @deprecated ICU 52. Do not rely on ucol_safeClone() cloning into any provided buffer.
 */
#define U_COL_SAFECLONE_BUFFERSIZE 1

#endif /* U_HIDE_DEPRECATED_API */

/**
 * Returns current rules. Delta defines whether full rules are returned or just the tailoring. 
 * Returns number of UChars needed to store rules. If buffer is NULL or bufferLen is not enough 
 * to store rules, will store up to available space.
 *
 * ucol_getRules() should normally be used instead.
 * See https://unicode-org.github.io/icu/userguide/collation/customization#building-on-existing-locales
 * @param coll collator to get the rules from
 * @param delta one of UCOL_TAILORING_ONLY, UCOL_FULL_RULES. 
 * @param buffer buffer to store the result in. If NULL, you'll get no rules.
 * @param bufferLen length of buffer to store rules in. If less than needed you'll get only the part that fits in.
 * @return current rules
 * @stable ICU 2.0
 * @see UCOL_FULL_RULES
 */
U_CAPI int32_t U_EXPORT2 
ucol_getRulesEx(const UCollator *coll, UColRuleOption delta, UChar *buffer, int32_t bufferLen);

#ifndef U_HIDE_DEPRECATED_API
/**
 * gets the locale name of the collator. If the collator
 * is instantiated from the rules, then this function returns
 * NULL.
 * @param coll The UCollator for which the locale is needed
 * @param type You can choose between requested, valid and actual
 *             locale. For description see the definition of
 *             ULocDataLocaleType in uloc.h
 * @param status error code of the operation
 * @return real locale name from which the collation data comes. 
 *         If the collator was instantiated from rules, returns
 *         NULL.
 * @deprecated ICU 2.8 Use ucol_getLocaleByType instead
 */
U_DEPRECATED const char * U_EXPORT2
ucol_getLocale(const UCollator *coll, ULocDataLocaleType type, UErrorCode *status);
#endif  /* U_HIDE_DEPRECATED_API */

/**
 * gets the locale name of the collator. If the collator
 * is instantiated from the rules, then this function returns
 * NULL.
 * @param coll The UCollator for which the locale is needed
 * @param type You can choose between requested, valid and actual
 *             locale. For description see the definition of
 *             ULocDataLocaleType in uloc.h
 * @param status error code of the operation
 * @return real locale name from which the collation data comes. 
 *         If the collator was instantiated from rules, returns
 *         NULL.
 * @stable ICU 2.8
 */
U_CAPI const char * U_EXPORT2
ucol_getLocaleByType(const UCollator *coll, ULocDataLocaleType type, UErrorCode *status);

/**
 * Get a Unicode set that contains all the characters and sequences tailored in 
 * this collator. The result must be disposed of by using uset_close.
 * @param coll        The UCollator for which we want to get tailored chars
 * @param status      error code of the operation
 * @return a pointer to newly created USet. Must be be disposed by using uset_close
 * @see ucol_openRules
 * @see uset_close
 * @stable ICU 2.4
 */
U_CAPI USet * U_EXPORT2
ucol_getTailoredSet(const UCollator *coll, UErrorCode *status);

#ifndef U_HIDE_INTERNAL_API
/** Calculates the set of unsafe code points, given a collator.
 *   A character is unsafe if you could append any character and cause the ordering to alter significantly.
 *   Collation sorts in normalized order, so anything that rearranges in normalization can cause this.
 *   Thus if you have a character like a_umlaut, and you add a lower_dot to it,
 *   then it normalizes to a_lower_dot + umlaut, and sorts differently.
 *  @param coll Collator
 *  @param unsafe a fill-in set to receive the unsafe points
 *  @param status for catching errors
 *  @return number of elements in the set
 *  @internal ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
ucol_getUnsafeSet( const UCollator *coll,
                  USet *unsafe,
                  UErrorCode *status);

/** Touches all resources needed for instantiating a collator from a short string definition,
 *  thus filling up the cache.
 * @param definition A short string containing a locale and a set of attributes. 
 *                   Attributes not explicitly mentioned are left at the default
 *                   state for a locale.
 * @param parseError if not NULL, structure that will get filled with error's pre
 *                   and post context in case of error.
 * @param forceDefaults if false, the settings that are the same as the collator 
 *                   default settings will not be applied (for example, setting
 *                   French secondary on a French collator would not be executed). 
 *                   If true, all the settings will be applied regardless of the 
 *                   collator default value. If the definition
 *                   strings are to be cached, should be set to false.
 * @param status     Error code. Apart from regular error conditions connected to 
 *                   instantiating collators (like out of memory or similar), this
 *                   API will return an error if an invalid attribute or attribute/value
 *                   combination is specified.
 * @see ucol_openFromShortString
 * @internal ICU 3.2.1
 */
U_CAPI void U_EXPORT2
ucol_prepareShortStringOpen( const char *definition,
                          UBool forceDefaults,
                          UParseError *parseError,
                          UErrorCode *status);
#endif  /* U_HIDE_INTERNAL_API */

/** Creates a binary image of a collator. This binary image can be stored and 
 *  later used to instantiate a collator using ucol_openBinary.
 *  This API supports preflighting.
 *  @param coll Collator
 *  @param buffer a fill-in buffer to receive the binary image
 *  @param capacity capacity of the destination buffer
 *  @param status for catching errors
 *  @return size of the image
 *  @see ucol_openBinary
 *  @stable ICU 3.2
 */
U_CAPI int32_t U_EXPORT2
ucol_cloneBinary(const UCollator *coll,
                 uint8_t *buffer, int32_t capacity,
                 UErrorCode *status);

/** Opens a collator from a collator binary image created using
 *  ucol_cloneBinary. Binary image used in instantiation of the 
 *  collator remains owned by the user and should stay around for 
 *  the lifetime of the collator. The API also takes a base collator
 *  which must be the root collator.
 *  @param bin binary image owned by the user and required through the
 *             lifetime of the collator
 *  @param length size of the image. If negative, the API will try to
 *                figure out the length of the image
 *  @param base Base collator, for lookup of untailored characters.
 *              Must be the root collator, must not be NULL.
 *              The base is required to be present through the lifetime of the collator.
 *  @param status for catching errors
 *  @return newly created collator
 *  @see ucol_cloneBinary
 *  @stable ICU 3.2
 */
U_CAPI UCollator* U_EXPORT2
ucol_openBinary(const uint8_t *bin, int32_t length, 
                const UCollator *base, 
                UErrorCode *status);

#if U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API

#include <functional>
#include <string_view>
#include <type_traits>

#include "unicode/char16ptr.h"
#include "unicode/unistr.h"

namespace U_HEADER_ONLY_NAMESPACE {

namespace collator {

namespace internal {

/**
 * Function object for performing comparisons using a UCollator.
 * @internal
 */
template <template <typename...> typename Compare, UCollationResult result>
class Predicate {
  public:
    /** @internal */
    explicit Predicate(const UCollator* ucol) : collator(ucol) {}

#if U_SHOW_CPLUSPLUS_API
    /** @internal */
    template <
        typename T, typename U,
        typename = std::enable_if_t<ConvertibleToU16StringView<T> && ConvertibleToU16StringView<U>>>
    bool operator()(const T& lhs, const U& rhs) const {
        return match(UnicodeString::readOnlyAlias(lhs), UnicodeString::readOnlyAlias(rhs));
    }
#else
    /** @internal */
    bool operator()(std::u16string_view lhs, std::u16string_view rhs) const {
        return match(lhs, rhs);
    }

#if !U_CHAR16_IS_TYPEDEF && (!defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 180000)
    /** @internal */
    bool operator()(std::basic_string_view<uint16_t> lhs, std::basic_string_view<uint16_t> rhs) const {
        return match({uprv_char16PtrFromUint16(lhs.data()), lhs.length()},
                     {uprv_char16PtrFromUint16(rhs.data()), rhs.length()});
    }
#endif

#if U_SIZEOF_WCHAR_T==2
    /** @internal */
    bool operator()(std::wstring_view lhs, std::wstring_view rhs) const {
        return match({uprv_char16PtrFromWchar(lhs.data()), lhs.length()},
                     {uprv_char16PtrFromWchar(rhs.data()), rhs.length()});
    }
#endif
#endif

    /** @internal */
    bool operator()(std::string_view lhs, std::string_view rhs) const {
        return match(lhs, rhs);
    }

#if defined(__cpp_char8_t)
    /** @internal */
    bool operator()(std::u8string_view lhs, std::u8string_view rhs) const {
        return match({reinterpret_cast<const char*>(lhs.data()), lhs.length()},
                     {reinterpret_cast<const char*>(rhs.data()), rhs.length()});
    }
#endif

  private:
    bool match(std::u16string_view lhs, std::u16string_view rhs) const {
        return compare(
            ucol_strcoll(
                collator,
                toUCharPtr(lhs.data()), static_cast<int32_t>(lhs.length()),
                toUCharPtr(rhs.data()), static_cast<int32_t>(rhs.length())),
            result);
    }

    bool match(std::string_view lhs, std::string_view rhs) const {
        UErrorCode status = U_ZERO_ERROR;
        return compare(
            ucol_strcollUTF8(
                collator,
                lhs.data(), static_cast<int32_t>(lhs.length()),
                rhs.data(), static_cast<int32_t>(rhs.length()),
                &status),
            result);
    }

    const UCollator* const collator;
    static constexpr Compare<UCollationResult> compare{};
};

}  // namespace internal

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::equal_to</code> but uses the collator instead of <code>operator==</code>.
 * @stable ICU 76
 */
using equal_to = internal::Predicate<std::equal_to, UCOL_EQUAL>;

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::greater</code> but uses the collator instead of <code>operator&gt;</code>.
 * @stable ICU 76
 */
using greater = internal::Predicate<std::equal_to, UCOL_GREATER>;

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::less</code> but uses the collator instead of <code>operator&lt;</code>.
 * @stable ICU 76
 */
using less = internal::Predicate<std::equal_to, UCOL_LESS>;

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::not_equal_to</code> but uses the collator instead of <code>operator!=</code>.
 * @stable ICU 76
 */
using not_equal_to = internal::Predicate<std::not_equal_to, UCOL_EQUAL>;

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::greater_equal</code> but uses the collator instead of <code>operator&gt;=</code>.
 * @stable ICU 76
 */
using greater_equal = internal::Predicate<std::not_equal_to, UCOL_LESS>;

/**
 * Function object for performing comparisons using this collator.
 * Like <code>std::less_equal</code> but uses the collator instead of <code>operator&lt;=</code>.
 * @stable ICU 76
 */
using less_equal = internal::Predicate<std::not_equal_to, UCOL_GREATER>;

}  // namespace collator

}  // namespace U_HEADER_ONLY_NAMESPACE

#endif  // U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API

#endif /* #if !UCONFIG_NO_COLLATION */

#endif
