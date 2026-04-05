// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __UDISPLAYOPTIONS_H__
#define __UDISPLAYOPTIONS_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

/**
 * \file
 * \brief C API: Display options (enum types, values, helper functions)
 *
 * These display options are designed to be used in class DisplayOptions
 * as a more modern version of the UDisplayContext mechanism.
 */

#include "unicode/uversion.h"

/**
 * Represents all the grammatical cases that are supported by CLDR.
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsGrammaticalCase {
    /**
     * A possible setting for GrammaticalCase.
     * The grammatical case context to be used is unknown (this is the default value).
     * @stable ICU 72
     */
    UDISPOPT_GRAMMATICAL_CASE_UNDEFINED = 0,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_ABLATIVE = 1,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_ACCUSATIVE = 2,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_COMITATIVE = 3,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_DATIVE = 4,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_ERGATIVE = 5,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_GENITIVE = 6,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_INSTRUMENTAL = 7,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_LOCATIVE = 8,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_LOCATIVE_COPULATIVE = 9,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_NOMINATIVE = 10,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_OBLIQUE = 11,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_PREPOSITIONAL = 12,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_SOCIATIVE = 13,
    /** @stable ICU 72 */
    UDISPOPT_GRAMMATICAL_CASE_VOCATIVE = 14,
} UDisplayOptionsGrammaticalCase;

/**
 * @param grammaticalCase The grammatical case.
 * @return the lowercase CLDR keyword string for the grammatical case.
 *
 * @stable ICU 72
 */
U_CAPI const char * U_EXPORT2
udispopt_getGrammaticalCaseIdentifier(UDisplayOptionsGrammaticalCase grammaticalCase);

/**
 * @param identifier in lower case such as "dative" or "nominative"
 * @return the plural category corresponding to the identifier, or `UDISPOPT_GRAMMATICAL_CASE_UNDEFINED`
 *
 * @stable ICU 72
 */
U_CAPI UDisplayOptionsGrammaticalCase U_EXPORT2
udispopt_fromGrammaticalCaseIdentifier(const char *identifier);

/**
 * Standard CLDR plural form/category constants.
 * See https://www.unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsPluralCategory {

    /**
     * A possible setting for PluralCategory.
     * The plural category case context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_PLURAL_CATEGORY_UNDEFINED = 0,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_ZERO = 1,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_ONE = 2,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_TWO = 3,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_FEW = 4,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_MANY = 5,
    /** @stable ICU 72 */
    UDISPOPT_PLURAL_CATEGORY_OTHER = 6,
} UDisplayOptionsPluralCategory;

/**
 * @param pluralCategory The plural category.
 * @return the lowercase CLDR identifier string for the plural category.
 *
 * @stable ICU 72
 */
U_CAPI const char * U_EXPORT2
udispopt_getPluralCategoryIdentifier(UDisplayOptionsPluralCategory pluralCategory);

/**
 * @param identifier for example "few" or "other"
 * @return the plural category corresponding to the identifier (plural keyword),
 *         or `UDISPOPT_PLURAL_CATEGORY_UNDEFINED`
 *
 * @stable ICU 72
 */
U_CAPI UDisplayOptionsPluralCategory U_EXPORT2
udispopt_fromPluralCategoryIdentifier(const char *identifier);

/**
 * Represents all the grammatical noun classes that are supported by CLDR.
 *
 * @stable ICU 72.
 */
typedef enum UDisplayOptionsNounClass {
    /**
     * A possible setting for NounClass.
     * The noun class case context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_NOUN_CLASS_UNDEFINED = 0,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_OTHER = 1,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_NEUTER = 2,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_FEMININE = 3,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_MASCULINE = 4,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_ANIMATE = 5,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_INANIMATE = 6,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_PERSONAL = 7,
    /** @stable ICU 72 */
    UDISPOPT_NOUN_CLASS_COMMON = 8,
} UDisplayOptionsNounClass;

/**
 * @param nounClass The noun class.
 * @return the lowercase CLDR keyword string for the noun class.
 *
 * @stable ICU 72
 */
U_CAPI const char * U_EXPORT2
udispopt_getNounClassIdentifier(UDisplayOptionsNounClass nounClass);

/**
 * @param identifier in lower case such as "feminine" or "masculine"
 * @return the plural category corresponding to the identifier, or `UDISPOPT_NOUN_CLASS_UNDEFINED`
 *
 * @stable ICU 72
 */
U_CAPI UDisplayOptionsNounClass U_EXPORT2
udispopt_fromNounClassIdentifier(const char *identifier);

/**
 * Represents all the capitalization options.
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsCapitalization {
    /**
     * A possible setting for Capitalization.
     * The capitalization context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_CAPITALIZATION_UNDEFINED = 0,

    /**
     * The capitalization context if a date, date symbol or display name is to be
     * formatted with capitalization appropriate for the beginning of a sentence.
     *
     * @stable ICU 72
     */
    UDISPOPT_CAPITALIZATION_BEGINNING_OF_SENTENCE = 1,

    /**
     * The capitalization context if a date, date symbol or display name is to be
     * formatted with capitalization appropriate for the middle of a sentence.
     *
     * @stable ICU 72
     */
    UDISPOPT_CAPITALIZATION_MIDDLE_OF_SENTENCE = 2,

    /**
     * The capitalization context if a date, date symbol or display name is to be
     * formatted with capitalization appropriate for stand-alone usage such as an
     * isolated name on a calendar page.
     *
     * @stable ICU 72
     */
    UDISPOPT_CAPITALIZATION_STANDALONE = 3,

    /**
     * The capitalization context if a date, date symbol or display name is to be
     * formatted with capitalization appropriate for a user-interface list or menu item.
     *
     * @stable ICU 72
     */
    UDISPOPT_CAPITALIZATION_UI_LIST_OR_MENU = 4,
} UDisplayOptionsCapitalization;

/**
 * Represents all the dialect handlings.
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsNameStyle {
    /**
     * A possible setting for NameStyle.
     * The NameStyle context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_NAME_STYLE_UNDEFINED = 0,

    /**
     * Use standard names when generating a locale name,
     * e.g. en_GB displays as 'English (United Kingdom)'.
     *
     * @stable ICU 72
     */
    UDISPOPT_NAME_STYLE_STANDARD_NAMES = 1,

    /**
     * Use dialect names, when generating a locale name,
     * e.g. en_GB displays as 'British English'.
     *
     * @stable ICU 72
     */
    UDISPOPT_NAME_STYLE_DIALECT_NAMES = 2,
} UDisplayOptionsNameStyle;

/**
 * Represents all the display lengths.
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsDisplayLength {
    /**
     * A possible setting for DisplayLength.
     * The DisplayLength context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_DISPLAY_LENGTH_UNDEFINED = 0,

    /**
     * Uses full names when generating a locale name,
     * e.g. "United States" for US.
     *
     * @stable ICU 72
     */
    UDISPOPT_DISPLAY_LENGTH_FULL = 1,

    /**
     * Use short names when generating a locale name,
     * e.g. "U.S." for US.
     *
     * @stable ICU 72
     */
    UDISPOPT_DISPLAY_LENGTH_SHORT = 2,
} UDisplayOptionsDisplayLength;

/**
 * Represents all the substitute handling.
 *
 * @stable ICU 72
 */
typedef enum UDisplayOptionsSubstituteHandling {

    /**
     * A possible setting for SubstituteHandling.
     * The SubstituteHandling context to be used is unknown (this is the default value).
     *
     * @stable ICU 72
     */
    UDISPOPT_SUBSTITUTE_HANDLING_UNDEFINED = 0,

    /**
     * Returns a fallback value (e.g., the input code) when no data is available.
     * This is the default behaviour.
     *
     * @stable ICU 72
     */
    UDISPOPT_SUBSTITUTE_HANDLING_SUBSTITUTE = 1,

    /**
     * Returns a null value when no data is available.
     *
     * @stable ICU 72
     */
    UDISPOPT_SUBSTITUTE_HANDLING_NO_SUBSTITUTE = 2,
} UDisplayOptionsSubstituteHandling;

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif // __UDISPLAYOPTIONS_H__
