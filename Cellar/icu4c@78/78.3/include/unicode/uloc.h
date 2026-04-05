// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1997-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*
* File ULOC.H
*
* Modification History:
*
*   Date        Name        Description
*   04/01/97    aliu        Creation.
*   08/22/98    stephen     JDK 1.2 sync.
*   12/08/98    rtg         New C API for Locale
*   03/30/99    damiba      overhaul
*   03/31/99    helena      Javadoc for uloc functions.
*   04/15/99    Madhu       Updated Javadoc
********************************************************************************
*/

#ifndef ULOC_H
#define ULOC_H

#include "unicode/utypes.h"
#include "unicode/uenum.h"

/**
 * \file
 * \brief C API: Locale ID functionality similar to C++ class Locale
 *
 * <h2> ULoc C API for Locale </h2>
 * A <code>Locale</code> represents a specific geographical, political,
 * or cultural region. An operation that requires a <code>Locale</code> to perform
 * its task is called <em>locale-sensitive</em> and uses the <code>Locale</code>
 * to tailor information for the user. For example, displaying a number
 * is a locale-sensitive operation--the number should be formatted
 * according to the customs/conventions of the user's native country,
 * region, or culture.  In the C APIs, a locales is simply a const char string.
 *
 * <P>
 * You create a <code>Locale</code> with one of the three options listed below.
 * Each of the component is separated by '_' in the locale string.
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 *       newLanguage
 * 
 *       newLanguage + newCountry
 * 
 *       newLanguage + newCountry + newVariant
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 * The first option is a valid <STRONG>ISO
 * Language Code.</STRONG> These codes are the lower-case two-letter
 * codes as defined by ISO-639.
 * You can find a full list of these codes at a number of sites, such as:
 * <BR><a href ="http://www.ics.uci.edu/pub/ietf/http/related/iso639.txt">
 * http://www.ics.uci.edu/pub/ietf/http/related/iso639.txt</a>
 *
 * <P>
 * The second option includes an additional <STRONG>ISO Country
 * Code.</STRONG> These codes are the upper-case two-letter codes
 * as defined by ISO-3166.
 * You can find a full list of these codes at a number of sites, such as:
 * <BR><a href="http://www.chemie.fu-berlin.de/diverse/doc/ISO_3166.html">
 * http://www.chemie.fu-berlin.de/diverse/doc/ISO_3166.html</a>
 *
 * <P>
 * The third option requires another additional information--the 
 * <STRONG>Variant.</STRONG>
 * The Variant codes are vendor and browser-specific.
 * For example, use WIN for Windows, MAC for Macintosh, and POSIX for POSIX.
 * Where there are two variants, separate them with an underscore, and
 * put the most important one first. For
 * example, a Traditional Spanish collation might be referenced, with
 * "ES", "ES", "Traditional_WIN".
 *
 * <P>
 * Because a <code>Locale</code> is just an identifier for a region,
 * no validity check is performed when you specify a <code>Locale</code>.
 * If you want to see whether particular resources are available for the
 * <code>Locale</code> you asked for, you must query those resources. For
 * example, ask the <code>UNumberFormat</code> for the locales it supports
 * using its <code>getAvailable</code> method.
 * <BR><STRONG>Note:</STRONG> When you ask for a resource for a particular
 * locale, you get back the best available match, not necessarily
 * precisely what you asked for. For more information, look at
 * <code>UResourceBundle</code>.
 *
 * <P>
 * The <code>Locale</code> provides a number of convenient constants
 * that you can use to specify the commonly used
 * locales. For example, the following refers to a locale
 * for the United States:
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 *       ULOC_US
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * <P>
 * Once you've specified a locale you can query it for information about
 * itself. Use <code>uloc_getCountry</code> to get the ISO Country Code and
 * <code>uloc_getLanguage</code> to get the ISO Language Code. You can
 * use <code>uloc_getDisplayCountry</code> to get the
 * name of the country suitable for displaying to the user. Similarly,
 * you can use <code>uloc_getDisplayLanguage</code> to get the name of
 * the language suitable for displaying to the user. Interestingly,
 * the <code>uloc_getDisplayXXX</code> methods are themselves locale-sensitive
 * and have two versions: one that uses the default locale and one
 * that takes a locale as an argument and displays the name or country in
 * a language appropriate to that locale.
 *
 * <P>
 * The ICU provides a number of services that perform locale-sensitive
 * operations. For example, the <code>unum_xxx</code> functions format
 * numbers, currency, or percentages in a locale-sensitive manner. 
 * </P>
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 *     UErrorCode success = U_ZERO_ERROR;
 *     UNumberFormat *nf;
 *     const char* myLocale = "fr_FR";
 * 
 *     nf = unum_open( UNUM_DEFAULT, NULL, success );          
 *     unum_close(nf);
 *     nf = unum_open( UNUM_CURRENCY, NULL, success );
 *     unum_close(nf);
 *     nf = unum_open( UNUM_PERCENT, NULL, success );   
 *     unum_close(nf);
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 * Each of these methods has two variants; one with an explicit locale
 * and one without; the latter using the default locale.
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code 
 * 
 *     nf = unum_open( UNUM_DEFAULT, myLocale, success );          
 *     unum_close(nf);
 *     nf = unum_open( UNUM_CURRENCY, myLocale, success );
 *     unum_close(nf);
 *     nf = unum_open( UNUM_PERCENT, myLocale, success );   
 *     unum_close(nf);
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 * A <code>Locale</code> is the mechanism for identifying the kind of services
 * (<code>UNumberFormat</code>) that you would like to get. The locale is
 * <STRONG>just</STRONG> a mechanism for identifying these services.
 *
 * <P>
 * Each international service that performs locale-sensitive operations 
 * allows you
 * to get all the available objects of that type. You can sift
 * through these objects by language, country, or variant,
 * and use the display names to present a menu to the user.
 * For example, you can create a menu of all the collation objects
 * suitable for a given language. Such classes implement these
 * three class methods:
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 *       const char* uloc_getAvailable(int32_t index);
 *       int32_t uloc_countAvailable();
 *       int32_t
 *       uloc_getDisplayName(const char* localeID,
 *                 const char* inLocaleID, 
 *                 UChar* result,
 *                 int32_t maxResultSize,
 *                  UErrorCode* err);
 * 
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 * <P>
 * Concerning POSIX/RFC1766 Locale IDs, 
 *  the getLanguage/getCountry/getVariant/getName functions do understand
 * the POSIX type form of  language_COUNTRY.ENCODING\@VARIANT
 * and if there is not an ICU-stype variant, uloc_getVariant() for example
 * will return the one listed after the \@at sign. As well, the hyphen
 * "-" is recognized as a country/variant separator similarly to RFC1766.
 * So for example, "en-us" will be interpreted as en_US.  
 * As a result, uloc_getName() is far from a no-op, and will have the
 * effect of converting POSIX/RFC1766 IDs into ICU form, although it does
 * NOT map any of the actual codes (i.e. russian->ru) in any way.
 * Applications should call uloc_getName() at the point where a locale ID
 * is coming from an external source (user entry, OS, web browser)
 * and pass the resulting string to other ICU functions.  For example,
 * don't use de-de\@EURO as an argument to resourcebundle.
 *
 * @see UResourceBundle
 */

/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_CHINESE            "zh"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_ENGLISH            "en"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_FRENCH             "fr"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_GERMAN             "de"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_ITALIAN            "it"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_JAPANESE           "ja"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_KOREAN             "ko"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_SIMPLIFIED_CHINESE "zh_CN"
/** Useful constant for this language. @stable ICU 2.0 */
#define ULOC_TRADITIONAL_CHINESE "zh_TW"

/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_CANADA         "en_CA"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_CANADA_FRENCH  "fr_CA"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_CHINA          "zh_CN"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_PRC            "zh_CN"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_FRANCE         "fr_FR"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_GERMANY        "de_DE"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_ITALY          "it_IT"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_JAPAN          "ja_JP"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_KOREA          "ko_KR"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_TAIWAN         "zh_TW"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_UK             "en_GB"
/** Useful constant for this country/region. @stable ICU 2.0 */
#define ULOC_US             "en_US"

/**
 * Useful constant for the maximum size of the language part of a locale ID.
 * (including the terminating NULL).
 * @stable ICU 2.0
 */
#define ULOC_LANG_CAPACITY 12

/**
 * Useful constant for the maximum size of the country part of a locale ID
 * (including the terminating NULL).
 * @stable ICU 2.0
 */
#define ULOC_COUNTRY_CAPACITY 4
/**
 * Useful constant for the maximum size of the whole locale ID
 * (including the terminating NULL and all keywords).
 * @stable ICU 2.0
 */
#define ULOC_FULLNAME_CAPACITY 157

/**
 * Useful constant for the maximum size of the script part of a locale ID
 * (including the terminating NULL).
 * @stable ICU 2.8
 */
#define ULOC_SCRIPT_CAPACITY 6

/**
 * Useful constant for the maximum size of keywords in a locale
 * @stable ICU 2.8
 */
#define ULOC_KEYWORDS_CAPACITY 96

/**
 * Useful constant for the maximum total size of keywords and their values in a locale
 * @stable ICU 2.8
 */
#define ULOC_KEYWORD_AND_VALUES_CAPACITY 100

/**
 * Invariant character separating keywords from the locale string
 * @stable ICU 2.8
 */
#define ULOC_KEYWORD_SEPARATOR '@'

/**
  * Unicode code point for '@' separating keywords from the locale string.
  * @see ULOC_KEYWORD_SEPARATOR
  * @stable ICU 4.6
  */
#define ULOC_KEYWORD_SEPARATOR_UNICODE 0x40

/**
 * Invariant character for assigning value to a keyword
 * @stable ICU 2.8
 */
#define ULOC_KEYWORD_ASSIGN '='

/**
  * Unicode code point for '=' for assigning value to a keyword.
  * @see ULOC_KEYWORD_ASSIGN
  * @stable ICU 4.6 
  */
#define ULOC_KEYWORD_ASSIGN_UNICODE 0x3D

/**
 * Invariant character separating keywords
 * @stable ICU 2.8
 */
#define ULOC_KEYWORD_ITEM_SEPARATOR ';'

/**
  * Unicode code point for ';' separating keywords
  * @see ULOC_KEYWORD_ITEM_SEPARATOR
  * @stable ICU 4.6
  */
#define ULOC_KEYWORD_ITEM_SEPARATOR_UNICODE 0x3B

/**
 * Constants for *_getLocale()
 * Allow user to select whether she wants information on 
 * requested, valid or actual locale.
 * For example, a collator for "en_US_CALIFORNIA" was
 * requested. In the current state of ICU (2.0), 
 * the requested locale is "en_US_CALIFORNIA",
 * the valid locale is "en_US" (most specific locale supported by ICU)
 * and the actual locale is "root" (the collation data comes unmodified 
 * from the UCA)
 * The locale is considered supported by ICU if there is a core ICU bundle 
 * for that locale (although it may be empty).
 * @stable ICU 2.1
 */
typedef enum {
  /** This is locale the data actually comes from 
   * @stable ICU 2.1
   */
  ULOC_ACTUAL_LOCALE    = 0,
  /** This is the most specific locale supported by ICU 
   * @stable ICU 2.1
   */
  ULOC_VALID_LOCALE    = 1,

#ifndef U_HIDE_DEPRECATED_API
  /** This is the requested locale
   *  @deprecated ICU 2.8 
   */
  ULOC_REQUESTED_LOCALE = 2,

    /**
     * One more than the highest normal ULocDataLocaleType value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    ULOC_DATA_LOCALE_TYPE_LIMIT = 3
#endif  // U_HIDE_DEPRECATED_API
} ULocDataLocaleType;

#ifndef U_HIDE_SYSTEM_API
/**
 * Gets ICU's default locale.  
 * The returned string is a snapshot in time, and will remain valid
 *   and unchanged even when uloc_setDefault() is called.
 *   The returned storage is owned by ICU, and must not be altered or deleted
 *   by the caller.
 *  
 * @return the ICU default locale
 * @system
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2
uloc_getDefault(void);

/**
 * Sets ICU's default locale.  
 *    By default (without calling this function), ICU's default locale will be based
 *    on information obtained from the underlying system environment.
 *    <p>
 *    Changes to ICU's default locale do not propagate back to the
 *    system environment.
 *    <p>
 *    Changes to ICU's default locale to not affect any ICU services that
 *    may already be open based on the previous default locale value.
 *
 * @param localeID the new ICU default locale. A value of NULL will try to get
 *                 the system's default locale.
 * @param status the error information if the setting of default locale fails
 * @system
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
uloc_setDefault(const char* localeID,
        UErrorCode*       status);
#endif  /* U_HIDE_SYSTEM_API */

/**
 * Gets the language code for the specified locale.
 *
 * This function may return with a failure error code for certain kinds of inputs
 * but does not fully check for well-formed locale IDs / language tags.
 *
 * @param localeID the locale to get the ISO language code with
 * @param language the language code for localeID
 * @param languageCapacity the size of the language buffer to store the  
 * language code with
 * @param err error information if retrieving the language code failed
 * @return the actual buffer size needed for the language code.  If it's greater 
 * than languageCapacity, the returned language code will be truncated.  
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getLanguage(const char*    localeID,
         char* language,
         int32_t languageCapacity,
         UErrorCode* err);

/**
 * Gets the script code for the specified locale.
 *
 * This function may return with a failure error code for certain kinds of inputs
 * but does not fully check for well-formed locale IDs / language tags.
 *
 * @param localeID the locale to get the ISO language code with
 * @param script the language code for localeID
 * @param scriptCapacity the size of the language buffer to store the  
 * language code with
 * @param err error information if retrieving the language code failed
 * @return the actual buffer size needed for the language code.  If it's greater 
 * than scriptCapacity, the returned language code will be truncated.  
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getScript(const char*    localeID,
         char* script,
         int32_t scriptCapacity,
         UErrorCode* err);

/**
 * Gets the  country code for the specified locale.
 *
 * This function may return with a failure error code for certain kinds of inputs
 * but does not fully check for well-formed locale IDs / language tags.
 *
 * @param localeID the locale to get the country code with
 * @param country the country code for localeID
 * @param countryCapacity the size of the country buffer to store the  
 * country code with
 * @param err error information if retrieving the country code failed
 * @return the actual buffer size needed for the country code.  If it's greater 
 * than countryCapacity, the returned country code will be truncated.  
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getCountry(const char*    localeID,
        char* country,
        int32_t countryCapacity,
        UErrorCode* err);

/**
 * Gets the variant code for the specified locale.
 *
 * This function may return with a failure error code for certain kinds of inputs
 * but does not fully check for well-formed locale IDs / language tags.
 *
 * @param localeID the locale to get the variant code with
 * @param variant the variant code for localeID
 * @param variantCapacity the size of the variant buffer to store the 
 * variant code with
 * @param err error information if retrieving the variant code failed
 * @return the actual buffer size needed for the variant code.  If it's greater 
 * than variantCapacity, the returned variant code will be truncated.  
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getVariant(const char*    localeID,
        char* variant,
        int32_t variantCapacity,
        UErrorCode* err);


/**
 * Gets the full name for the specified locale.
 *
 * This function may return with a failure error code for certain kinds of inputs
 * but does not fully check for well-formed locale IDs / language tags.
 *
 * Note: This has the effect of 'canonicalizing' the ICU locale ID to
 * a certain extent. Upper and lower case are set as needed.
 * It does NOT map aliased names in any way.
 * See the top of this header file.
 * This API supports preflighting.
 *
 * @param localeID the locale to get the full name with
 * @param name fill in buffer for the name without keywords.
 * @param nameCapacity capacity of the fill in buffer.
 * @param err error information if retrieving the full name failed
 * @return the actual buffer size needed for the full name.  If it's greater 
 * than nameCapacity, the returned full name will be truncated.  
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getName(const char*    localeID,
         char* name,
         int32_t nameCapacity,
         UErrorCode* err);

/**
 * Gets the full name for the specified locale.
 * Note: This has the effect of 'canonicalizing' the string to
 * a certain extent. Upper and lower case are set as needed,
 * and if the components were in 'POSIX' format they are changed to
 * ICU format.  It does NOT map aliased names in any way.
 * See the top of this header file.
 *
 * @param localeID the locale to get the full name with
 * @param name the full name for localeID
 * @param nameCapacity the size of the name buffer to store the 
 * full name with
 * @param err error information if retrieving the full name failed
 * @return the actual buffer size needed for the full name.  If it's greater 
 * than nameCapacity, the returned full name will be truncated.  
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_canonicalize(const char*    localeID,
         char* name,
         int32_t nameCapacity,
         UErrorCode* err);

/**
 * Gets the ISO language code for the specified locale.
 *
 * @param localeID the locale to get the ISO language code with
 * @return language the ISO language code for localeID
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2
uloc_getISO3Language(const char* localeID);


/**
 * Gets the ISO country code for the specified locale.
 *
 * @param localeID the locale to get the ISO country code with
 * @return country the ISO country code for localeID
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2
uloc_getISO3Country(const char* localeID);

/**
 * Gets the Win32 LCID value for the specified locale.
 * If the ICU locale is not recognized by Windows, 0 will be returned.
 *
 * LCIDs were deprecated with Windows Vista and Microsoft recommends
 * that developers use BCP47 style tags instead (uloc_toLanguageTag).
 *
 * @param localeID the locale to get the Win32 LCID value with
 * @return country the Win32 LCID for localeID
 * @stable ICU 2.0
 */
U_CAPI uint32_t U_EXPORT2
uloc_getLCID(const char* localeID);

/**
 * Gets the language name suitable for display for the specified locale.
 *
 * @param locale the locale to get the ISO language code with
 * @param displayLocale Specifies the locale to be used to display the name. In
 *                 other words, if the locale's language code is "en", passing
 *                 Locale::getFrench() for inLocale would result in "Anglais",
 *                 while passing Locale::getGerman() for inLocale would result
 *                 in "Englisch".
 * @param language the displayable language code for localeID
 * @param languageCapacity the size of the language buffer to store the
 *                 displayable language code with.
 * @param status error information if retrieving the displayable language code
 *                 failed. U_USING_DEFAULT_WARNING indicates that no data was
 *                 found from the locale resources and a case canonicalized
 *                 language code is placed into language as fallback.
 * @return the actual buffer size needed for the displayable language code. If
 *                 it's greater than languageCapacity, the returned language
 *                 code will be truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayLanguage(const char* locale,
            const char* displayLocale,
            UChar* language,
            int32_t languageCapacity,
            UErrorCode* status);

/**
 * Gets the script name suitable for display for the specified locale.
 *
 * @param locale the locale to get the displayable script code with. NULL may be
 *                 used to specify the default.
 * @param displayLocale Specifies the locale to be used to display the name. In
 *                 other words, if the locale's language code is "en", passing
 *                 Locale::getFrench() for inLocale would result in "", while
 *                 passing Locale::getGerman() for inLocale would result in "".
 *                 NULL may be used to specify the default.
 * @param script the displayable script for the localeID.
 * @param scriptCapacity the size of the script buffer to store the displayable
 *                 script code with.
 * @param status error information if retrieving the displayable script code
 *                 failed. U_USING_DEFAULT_WARNING indicates that no data was
 *                 found from the locale resources and a case canonicalized
 *                 script code is placed into script as fallback.
 * @return the actual buffer size needed for the displayable script code. If
 *                 it's greater than scriptCapacity, the returned displayable
 *                 script code will be truncated.
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayScript(const char* locale,
            const char* displayLocale,
            UChar* script,
            int32_t scriptCapacity,
            UErrorCode* status);

/**
 * Gets the country name suitable for display for the specified locale.
 * Warning: this is for the region part of a valid locale ID; it cannot just be
 * the region code (like "FR"). To get the display name for a region alone, or
 * for other options, use ULocaleDisplayNames instead.
 *
 * @param locale the locale to get the displayable country code with. NULL may
 *                 be used to specify the default.
 * @param displayLocale Specifies the locale to be used to display the name. In
 *                 other words, if the locale's language code is "en", passing
 *                 Locale::getFrench() for inLocale would result in "Anglais",
 *                 while passing Locale::getGerman() for inLocale would result
 *                 in "Englisch". NULL may be used to specify the default.
 * @param country the displayable country code for localeID.
 * @param countryCapacity the size of the country buffer to store the
 *                 displayable country code with.
 * @param status error information if retrieving the displayable country code
 *                 failed. U_USING_DEFAULT_WARNING indicates that no data was
 *                 found from the locale resources and a case canonicalized
 *                 country code is placed into country as fallback.
 * @return the actual buffer size needed for the displayable country code. If
 *                 it's greater than countryCapacity, the returned displayable
 *                 country code will be truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayCountry(const char* locale,
                       const char* displayLocale,
                       UChar* country,
                       int32_t countryCapacity,
                       UErrorCode* status);


/**
 * Gets the variant name suitable for display for the specified locale.
 *
 * @param locale the locale to get the displayable variant code with. NULL may
 *                 be used to specify the default.
 * @param displayLocale Specifies the locale to be used to display the name. In
 *                 other words, if the locale's language code is "en", passing
 *                 Locale::getFrench() for inLocale would result in "Anglais",
 *                 while passing Locale::getGerman() for inLocale would result
 *                 in "Englisch". NULL may be used to specify the default.
 * @param variant the displayable variant code for localeID.
 * @param variantCapacity the size of the variant buffer to store the
 *                 displayable variant code with.
 * @param status error information if retrieving the displayable variant code
 *                 failed. U_USING_DEFAULT_WARNING indicates that no data was
 *                 found from the locale resources and a case canonicalized
 *                 variant code is placed into variant as fallback.
 * @return the actual buffer size needed for the displayable variant code. If
 *                 it's greater than variantCapacity, the returned displayable
 *                 variant code will be truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayVariant(const char* locale,
                       const char* displayLocale,
                       UChar* variant,
                       int32_t variantCapacity,
                       UErrorCode* status);

/**
 * Gets the keyword name suitable for display for the specified locale. E.g:
 * for the locale string de_DE\@collation=PHONEBOOK, this API gets the display
 * string for the keyword collation.
 * Usage:
 * <code>
 *    UErrorCode status = U_ZERO_ERROR;
 *    const char* keyword =NULL;
 *    int32_t keywordLen = 0;
 *    int32_t keywordCount = 0;
 *    UChar displayKeyword[256];
 *    int32_t displayKeywordLen = 0;
 *    UEnumeration* keywordEnum = uloc_openKeywords("de_DE@collation=PHONEBOOK;calendar=TRADITIONAL", &status);
 *    for(keywordCount = uenum_count(keywordEnum, &status); keywordCount > 0 ; keywordCount--){
 *          if(U_FAILURE(status)){
 *              ...something went wrong so handle the error...
 *              break;
 *          }
 *          // the uenum_next returns NUL terminated string
 *          keyword = uenum_next(keywordEnum, &keywordLen, &status);
 *          displayKeywordLen = uloc_getDisplayKeyword(keyword, "en_US", displayKeyword, 256);
 *          ... do something interesting .....
 *    }
 *    uenum_close(keywordEnum);
 * </code>
 * @param keyword           The keyword whose display string needs to be returned.
 * @param displayLocale     Specifies the locale to be used to display the name.  In other words,
 *                          if the locale's language code is "en", passing Locale::getFrench() for
 *                          inLocale would result in "Anglais", while passing Locale::getGerman()
 *                          for inLocale would result in "Englisch". NULL may be used to specify the default.
 * @param dest              the buffer to which the displayable keyword should be written.
 * @param destCapacity      The size of the buffer (number of UChars). If it is 0, then
 *                          dest may be NULL and the function will only return the length of the
 *                          result without writing any of the result string (pre-flighting).
 * @param status            error information if retrieving the displayable string failed.
 *                          Should not be NULL and should not indicate failure on entry.
 *                          U_USING_DEFAULT_WARNING indicates that no data was found from the locale
 *                          resources and the keyword is placed into dest as fallback.
 * @return the actual buffer size needed for the displayable variant code.
 * @see #uloc_openKeywords
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayKeyword(const char* keyword,
                       const char* displayLocale,
                       UChar* dest,
                       int32_t destCapacity,
                       UErrorCode* status);
/**
 * Gets the value of the keyword suitable for display for the specified locale.
 * E.g: for the locale string de_DE\@collation=PHONEBOOK, this API gets the display
 * string for PHONEBOOK, in the display locale, when "collation" is specified as the keyword.
 *
 * @param locale            The locale to get the displayable variant code with. NULL may be used to specify the default.
 * @param keyword           The keyword for whose value should be used.
 * @param displayLocale     Specifies the locale to be used to display the name.  In other words,
 *                          if the locale's language code is "en", passing Locale::getFrench() for
 *                          inLocale would result in "Anglais", while passing Locale::getGerman()
 *                          for inLocale would result in "Englisch". NULL may be used to specify the default.
 * @param dest              the buffer to which the displayable keyword should be written.
 * @param destCapacity      The size of the buffer (number of UChars). If it is 0, then
 *                          dest may be NULL and the function will only return the length of the
 *                          result without writing any of the result string (pre-flighting).
 * @param status            error information if retrieving the displayable string failed.
 *                          Should not be NULL and must not indicate failure on entry.
 *                          U_USING_DEFAULT_WARNING indicates that no data was found from the locale
 *                          resources and the value of the keyword is placed into dest as fallback.
 * @return the actual buffer size needed for the displayable variant code.
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayKeywordValue(   const char* locale,
                               const char* keyword,
                               const char* displayLocale,
                               UChar* dest,
                               int32_t destCapacity,
                               UErrorCode* status);
/**
 * Gets the full name suitable for display for the specified locale.
 *
 * @param localeID the locale to get the displayable name with. NULL may be used to specify the default.
 * @param inLocaleID Specifies the locale to be used to display the name.  In other words,
 *                   if the locale's language code is "en", passing Locale::getFrench() for
 *                   inLocale would result in "Anglais", while passing Locale::getGerman()
 *                   for inLocale would result in "Englisch". NULL may be used to specify the default.
 * @param result the displayable name for localeID
 * @param maxResultSize the size of the name buffer to store the 
 * displayable full name with
 * @param err error information if retrieving the displayable name failed
 * @return the actual buffer size needed for the displayable name.  If it's greater 
 * than maxResultSize, the returned displayable name will be truncated.  
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getDisplayName(const char* localeID,
            const char* inLocaleID,
            UChar* result,
            int32_t maxResultSize,
            UErrorCode* err);


/**
 * Gets the specified locale from a list of available locales.
 *
 * This method corresponds to uloc_openAvailableByType called with the
 * ULOC_AVAILABLE_DEFAULT type argument.
 *
 * The return value is a pointer to an item of a locale name array. Both this
 * array and the pointers it contains are owned by ICU and should not be
 * deleted or written through by the caller. The locale name is terminated by
 * a null pointer.
 *
 * @param n the specific locale name index of the available locale list;
 *     should not exceed the number returned by uloc_countAvailable.
 * @return a specified locale name of all available locales
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2
uloc_getAvailable(int32_t n);

/**
 * Gets the size of the all available locale list.
 *
 * @return the size of the locale list
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 uloc_countAvailable(void);

/**
 * Types for uloc_getAvailableByType and uloc_countAvailableByType.
 *
 * @stable ICU 65
 */
typedef enum ULocAvailableType {
  /**
   * Locales that return data when passed to ICU APIs,
   * but not including legacy or alias locales.
   *
   * @stable ICU 65
   */
  ULOC_AVAILABLE_DEFAULT,

  /**
   * Legacy or alias locales that return data when passed to ICU APIs.
   * Examples of supported legacy or alias locales:
   *
   * - iw (alias to he)
   * - mo (alias to ro)
   * - zh_CN (alias to zh_Hans_CN)
   * - sr_BA (alias to sr_Cyrl_BA)
   * - ars (alias to ar_SA)
   *
   * The locales in this set are disjoint from the ones in
   * ULOC_AVAILABLE_DEFAULT. To get both sets at the same time, use
   * ULOC_AVAILABLE_WITH_LEGACY_ALIASES.
   *
   * @stable ICU 65
   */
  ULOC_AVAILABLE_ONLY_LEGACY_ALIASES,

  /**
   * The union of the locales in ULOC_AVAILABLE_DEFAULT and
   * ULOC_AVAILABLE_ONLY_LEGACY_ALIAS.
   *
   * @stable ICU 65
   */
  ULOC_AVAILABLE_WITH_LEGACY_ALIASES,

#ifndef U_HIDE_INTERNAL_API
  /**
   * @internal
   */
  ULOC_AVAILABLE_COUNT
#endif  /* U_HIDE_INTERNAL_API */
} ULocAvailableType;

/**
 * Gets a list of available locales according to the type argument, allowing
 * the user to access different sets of supported locales in ICU.
 *
 * The returned UEnumeration must be closed by the caller.
 *
 * @param type Type choice from ULocAvailableType.
 * @param status Set if an error occurred.
 * @return a UEnumeration owned by the caller, or nullptr on failure.
 * @stable ICU 65
 */
U_CAPI UEnumeration* U_EXPORT2
uloc_openAvailableByType(ULocAvailableType type, UErrorCode* status);

/**
 *
 * Gets a list of all available 2-letter language codes defined in ISO 639,
 * plus additional 3-letter codes determined to be useful for locale generation as
 * defined by Unicode CLDR. This is a pointer
 * to an array of pointers to arrays of char.  All of these pointers are owned
 * by ICU-- do not delete them, and do not write through them.  The array is
 * terminated with a null pointer.
 * @return a list of all available language codes
 * @stable ICU 2.0
 */
U_CAPI const char* const* U_EXPORT2
uloc_getISOLanguages(void);

/**
 *
 * Gets a list of all available 2-letter country codes defined in ISO 639.  This is a
 * pointer to an array of pointers to arrays of char.  All of these pointers are
 * owned by ICU-- do not delete them, and do not write through them.  The array is
 * terminated with a null pointer.
 * @return a list of all available country codes
 * @stable ICU 2.0
 */
U_CAPI const char* const* U_EXPORT2
uloc_getISOCountries(void);

/**
 * Truncate the locale ID string to get the parent locale ID.
 * Copies the part of the string before the last underscore.
 * The parent locale ID will be an empty string if there is no
 * underscore, or if there is only one underscore at localeID[0].
 *
 * @param localeID Input locale ID string.
 * @param parent   Output string buffer for the parent locale ID.
 * @param parentCapacity Size of the output buffer.
 * @param err A UErrorCode value.
 * @return The length of the parent locale ID.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
uloc_getParent(const char*    localeID,
                 char* parent,
                 int32_t parentCapacity,
                 UErrorCode* err);




/**
 * Gets the full name for the specified locale, like uloc_getName(),
 * but without keywords.
 *
 * Note: This has the effect of 'canonicalizing' the string to
 * a certain extent. Upper and lower case are set as needed,
 * and if the components were in 'POSIX' format they are changed to
 * ICU format.  It does NOT map aliased names in any way.
 * See the top of this header file.
 *
 * This API strips off the keyword part, so "de_DE\@collation=phonebook" 
 * will become "de_DE". 
 * This API supports preflighting.
 *
 * @param localeID the locale to get the full name with
 * @param name fill in buffer for the name without keywords.
 * @param nameCapacity capacity of the fill in buffer.
 * @param err error information if retrieving the full name failed
 * @return the actual buffer size needed for the full name.  If it's greater 
 * than nameCapacity, the returned full name will be truncated.  
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getBaseName(const char*    localeID,
         char* name,
         int32_t nameCapacity,
         UErrorCode* err);

/**
 * Gets an enumeration of keywords for the specified locale. Enumeration
 * must get disposed of by the client using uenum_close function.
 *
 * @param localeID the locale to get the variant code with
 * @param status error information if retrieving the keywords failed
 * @return enumeration of keywords or NULL if there are no keywords.
 * @stable ICU 2.8
 */
U_CAPI UEnumeration* U_EXPORT2
uloc_openKeywords(const char* localeID,
                        UErrorCode* status);

/**
 * Get the value for a keyword. Locale name does not need to be normalized.
 * 
 * @param localeID locale name containing the keyword ("de_DE@currency=EURO;collation=PHONEBOOK")
 * @param keywordName name of the keyword for which we want the value; must not be
 *  NULL or empty, and must consist only of [A-Za-z0-9]. Case insensitive.
 * @param buffer receiving buffer
 * @param bufferCapacity capacity of receiving buffer
 * @param status containing error code: e.g. buffer not big enough or ill-formed localeID
 *  or keywordName parameters.
 * @return the length of keyword value
 * @stable ICU 2.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getKeywordValue(const char* localeID,
                     const char* keywordName,
                     char* buffer, int32_t bufferCapacity,
                     UErrorCode* status);


/**
 * Sets or removes the value of the specified keyword.
 *
 * For removing all keywords, use uloc_getBaseName().
 *
 * NOTE: Unlike almost every other ICU function which takes a
 * buffer, this function will NOT truncate the output text, and will
 * not update the buffer with unterminated text setting a status of
 * U_STRING_NOT_TERMINATED_WARNING. If a BUFFER_OVERFLOW_ERROR is received,
 * it means a terminated version of the updated locale ID would not fit
 * in the buffer, and the original buffer is untouched. This is done to
 * prevent incorrect or possibly even malformed locales from being generated
 * and used.
 *
 * @param keywordName name of the keyword to be set; must not be
 *  NULL or empty, and must consist only of [A-Za-z0-9]. Case insensitive.
 * @param keywordValue value of the keyword to be set. If 0-length or
 *  NULL, will result in the keyword being removed; no error is given if 
 *  that keyword does not exist. Otherwise, must consist only of
 *  [A-Za-z0-9] and [/_+-].
 * @param buffer input buffer containing well-formed locale ID to be
 *  modified.
 * @param bufferCapacity capacity of receiving buffer
 * @param status containing error code: e.g. buffer not big enough
 *  or ill-formed keywordName or keywordValue parameters, or ill-formed
 *  locale ID in buffer on input.
 * @return the length needed for the buffer
 * @see uloc_getKeywordValue
 * @stable ICU 3.2
 */
U_CAPI int32_t U_EXPORT2
uloc_setKeywordValue(const char* keywordName,
                     const char* keywordValue,
                     char* buffer, int32_t bufferCapacity,
                     UErrorCode* status);

/**
 * Returns whether the locale's script is written right-to-left.
 * If there is no script subtag, then the likely script is used, see uloc_addLikelySubtags().
 * If no likely script is known, then false is returned.
 *
 * A script is right-to-left according to the CLDR script metadata
 * which corresponds to whether the script's letters have Bidi_Class=R or AL.
 *
 * Returns true for "ar" and "en-Hebr", false for "zh" and "fa-Cyrl".
 *
 * @param locale input locale ID
 * @return true if the locale's script is written right-to-left
 * @stable ICU 54
 */
U_CAPI UBool U_EXPORT2
uloc_isRightToLeft(const char *locale);

/**
 * enums for the  return value for the character and line orientation
 * functions.
 * @stable ICU 4.0
 */
typedef enum {
  ULOC_LAYOUT_LTR   = 0,  /* left-to-right. */
  ULOC_LAYOUT_RTL    = 1,  /* right-to-left. */
  ULOC_LAYOUT_TTB    = 2,  /* top-to-bottom. */
  ULOC_LAYOUT_BTT    = 3,   /* bottom-to-top. */
  ULOC_LAYOUT_UNKNOWN
} ULayoutType;

/**
 * Get the layout character orientation for the specified locale.
 * 
 * @param localeId locale name
 * @param status Error status
 * @return an enum indicating the layout orientation for characters.
 * @stable ICU 4.0
 */
U_CAPI ULayoutType U_EXPORT2
uloc_getCharacterOrientation(const char* localeId,
                             UErrorCode *status);

/**
 * Get the layout line orientation for the specified locale.
 * 
 * @param localeId locale name
 * @param status Error status
 * @return an enum indicating the layout orientation for lines.
 * @stable ICU 4.0
 */
U_CAPI ULayoutType U_EXPORT2
uloc_getLineOrientation(const char* localeId,
                        UErrorCode *status);

/**
 * Output values which uloc_acceptLanguage() writes to the 'outResult' parameter.
 *
 * @see uloc_acceptLanguageFromHTTP
 * @see uloc_acceptLanguage
 * @stable ICU 3.2
 */
typedef enum {
    /**
     * No exact match was found.
     * @stable ICU 3.2
     */
    ULOC_ACCEPT_FAILED   = 0,
    /**
     * An exact match was found.
     * @stable ICU 3.2
     */
    ULOC_ACCEPT_VALID    = 1,
    /**
     * A fallback was found. For example, the Accept-Language list includes 'ja_JP'
     * and is matched with available locale 'ja'.
     * @stable ICU 3.2
     */
    ULOC_ACCEPT_FALLBACK = 2   /*  */
} UAcceptResult;

/**
 * Based on a HTTP header from a web browser and a list of available locales,
 * determine an acceptable locale for the user.
 *
 * This is a thin wrapper over C++ class LocaleMatcher.
 *
 * @param result - buffer to accept the result locale
 * @param resultAvailable the size of the result buffer.
 * @param outResult - An out parameter that contains the fallback status
 * @param httpAcceptLanguage - "Accept-Language:" header as per HTTP.
 * @param availableLocales - list of available locales to match
 * @param status ICU error code. Its input value must pass the U_SUCCESS() test,
 *               or else the function returns immediately. Check for U_FAILURE()
 *               on output or use with function chaining. (See User Guide for details.)
 * @return length needed for the locale.
 * @stable ICU 3.2
 */
U_CAPI int32_t U_EXPORT2
uloc_acceptLanguageFromHTTP(char *result, int32_t resultAvailable,
                            UAcceptResult *outResult,
                            const char *httpAcceptLanguage,
                            UEnumeration* availableLocales,
                            UErrorCode *status);

/**
 * Based on a list of available locales,
 * determine an acceptable locale for the user.
 *
 * This is a thin wrapper over C++ class LocaleMatcher.
 *
 * @param result - buffer to accept the result locale
 * @param resultAvailable the size of the result buffer.
 * @param outResult - An out parameter that contains the fallback status
 * @param acceptList - list of acceptable languages
 * @param acceptListCount - count of acceptList items
 * @param availableLocales - list of available locales to match
 * @param status ICU error code. Its input value must pass the U_SUCCESS() test,
 *               or else the function returns immediately. Check for U_FAILURE()
 *               on output or use with function chaining. (See User Guide for details.)
 * @return length needed for the locale.
 * @stable ICU 3.2
 */
U_CAPI int32_t U_EXPORT2
uloc_acceptLanguage(char *result, int32_t resultAvailable, 
                    UAcceptResult *outResult, const char **acceptList,
                    int32_t acceptListCount,
                    UEnumeration* availableLocales,
                    UErrorCode *status);


/**
 * Gets the ICU locale ID for the specified Win32 LCID value.
 *
 * @param hostID the Win32 LCID to translate
 * @param locale the output buffer for the ICU locale ID, which will be NUL-terminated
 *  if there is room.
 * @param localeCapacity the size of the output buffer
 * @param status an error is returned if the LCID is unrecognized or the output buffer
 *  is too small
 * @return actual the actual size of the locale ID, not including NUL-termination 
 * @stable ICU 3.8
 */
U_CAPI int32_t U_EXPORT2
uloc_getLocaleForLCID(uint32_t hostID, char *locale, int32_t localeCapacity,
                    UErrorCode *status);


/**
 * Add the likely subtags for a provided locale ID, per the algorithm described
 * in the following CLDR technical report:
 *
 *   http://www.unicode.org/reports/tr35/#Likely_Subtags
 *
 * If localeID is already in the maximal form, or there is no data available
 * for maximization, it will be copied to the output buffer.  For example,
 * "sh" cannot be maximized, since there is no reasonable maximization.
 *
 * Examples:
 *
 * "und_Zzzz" maximizes to "en_Latn_US"
 *
 * "en" maximizes to "en_Latn_US"
 *
 * "de" maximizes to "de_Latn_DE"
 *
 * "sr" maximizes to "sr_Cyrl_RS"
 *
 * "zh_Hani" maximizes to "zh_Hani_CN"
 *
 *
 * @param localeID The locale to maximize
 * @param maximizedLocaleID The maximized locale
 * @param maximizedLocaleIDCapacity The capacity of the maximizedLocaleID buffer
 * @param err Error information if maximizing the locale failed.  If the length
 * of the localeID and the null-terminator is greater than the maximum allowed size,
 * or the localeId is not well-formed, the error code is U_ILLEGAL_ARGUMENT_ERROR.
 * @return The actual buffer size needed for the maximized locale.  If it's
 * greater than maximizedLocaleIDCapacity, the returned ID will be truncated.
 * On error, the return value is -1.
 * @stable ICU 4.0
 */
U_CAPI int32_t U_EXPORT2
uloc_addLikelySubtags(const char*    localeID,
         char* maximizedLocaleID,
         int32_t maximizedLocaleIDCapacity,
         UErrorCode* err);


/**
 * Minimize the subtags for a provided locale ID, per the algorithm described
 * in the following CLDR technical report:
 *
 *   http://www.unicode.org/reports/tr35/#Likely_Subtags
 *
 * If localeID is already in the minimal form, or there is no data available
 * for minimization, it will be copied to the output buffer.  Since the
 * minimization algorithm relies on proper maximization, see the comments
 * for uloc_addLikelySubtags for reasons why there might not be any data.
 *
 * Examples:
 *
 * "en_Latn_US" minimizes to "en"
 *
 * "de_Latn_US" minimizes to "de"
 *
 * "sr_Cyrl_RS" minimizes to "sr"
 *
 * "zh_Hant_TW" minimizes to "zh_TW" (The region is preferred to the
 * script, and minimizing to "zh" would imply "zh_Hans_CN".)
 *
 * @param localeID The locale to minimize
 * @param minimizedLocaleID The minimized locale
 * @param minimizedLocaleIDCapacity The capacity of the minimizedLocaleID buffer
 * @param err Error information if minimizing the locale failed.  If the length
 * of the localeID and the null-terminator is greater than the maximum allowed size,
 * or the localeId is not well-formed, the error code is U_ILLEGAL_ARGUMENT_ERROR.
 * @return The actual buffer size needed for the minimized locale.  If it's
 * greater than minimizedLocaleIDCapacity, the returned ID will be truncated.
 * On error, the return value is -1.
 * @stable ICU 4.0
 */
U_CAPI int32_t U_EXPORT2
uloc_minimizeSubtags(const char*    localeID,
         char* minimizedLocaleID,
         int32_t minimizedLocaleIDCapacity,
         UErrorCode* err);

/**
 * Returns a locale ID for the specified BCP47 language tag string.
 * If the specified language tag contains any ill-formed subtags,
 * the first such subtag and all following subtags are ignored.
 * <p>
 * This implements the 'Language-Tag' production of BCP 47, and so
 * supports legacy language tags (marked as “Type: grandfathered” in BCP 47)
 * (regular and irregular) as well as private use language tags.
 *
 * Private use tags are represented as 'x-whatever',
 * and legacy tags are converted to their canonical replacements where they exist.
 *
 * Note that a few legacy tags have no modern replacement;
 * these will be converted using the fallback described in
 * the first paragraph, so some information might be lost.
 *
 * @param langtag   the input BCP47 language tag.
 * @param localeID  the output buffer receiving a locale ID for the
 *                  specified BCP47 language tag.
 * @param localeIDCapacity  the size of the locale ID output buffer.
 * @param parsedLength  if not NULL, successfully parsed length
 *                      for the input language tag is set.
 * @param err       error information if receiving the locald ID
 *                  failed.
 * @return          the length of the locale ID.
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uloc_forLanguageTag(const char* langtag,
                    char* localeID,
                    int32_t localeIDCapacity,
                    int32_t* parsedLength,
                    UErrorCode* err);

/**
 * Returns a well-formed language tag for this locale ID. 
 * <p> 
 * <b>Note</b>: When <code>strict</code> is false, any locale
 * fields which do not satisfy the BCP47 syntax requirement will
 * be omitted from the result.  When <code>strict</code> is
 * true, this function sets U_ILLEGAL_ARGUMENT_ERROR to the
 * <code>err</code> if any locale fields do not satisfy the
 * BCP47 syntax requirement.
 * @param localeID  the input locale ID
 * @param langtag   the output buffer receiving BCP47 language
 *                  tag for the locale ID.
 * @param langtagCapacity   the size of the BCP47 language tag
 *                          output buffer.
 * @param strict    boolean value indicating if the function returns
 *                  an error for an ill-formed input locale ID.
 * @param err       error information if receiving the language
 *                  tag failed.
 * @return          The length of the BCP47 language tag.
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uloc_toLanguageTag(const char* localeID,
                   char* langtag,
                   int32_t langtagCapacity,
                   UBool strict,
                   UErrorCode* err);

/**
 * Converts the specified keyword (legacy key, or BCP 47 Unicode locale
 * extension key) to the equivalent BCP 47 Unicode locale extension key.
 * For example, BCP 47 Unicode locale extension key "co" is returned for
 * the input keyword "collation".
 * <p>
 * When the specified keyword is unknown, but satisfies the BCP syntax,
 * then the pointer to the input keyword itself will be returned.
 * For example,
 * <code>uloc_toUnicodeLocaleKey("ZZ")</code> returns "ZZ".
 * 
 * @param keyword       the input locale keyword (either legacy key
 *                      such as "collation" or BCP 47 Unicode locale extension
 *                      key such as "co").
 * @return              the well-formed BCP 47 Unicode locale extension key,
 *                      or NULL if the specified locale keyword cannot be
 *                      mapped to a well-formed BCP 47 Unicode locale extension
 *                      key. 
 * @see uloc_toLegacyKey
 * @stable ICU 54
 */
U_CAPI const char* U_EXPORT2
uloc_toUnicodeLocaleKey(const char* keyword);

/**
 * Converts the specified keyword value (legacy type, or BCP 47
 * Unicode locale extension type) to the well-formed BCP 47 Unicode locale
 * extension type for the specified keyword (category). For example, BCP 47
 * Unicode locale extension type "phonebk" is returned for the input
 * keyword value "phonebook", with the keyword "collation" (or "co").
 * <p>
 * When the specified keyword is not recognized, but the specified value
 * satisfies the syntax of the BCP 47 Unicode locale extension type,
 * or when the specified keyword allows 'variable' type and the specified
 * value satisfies the syntax,  then the pointer to the input type value itself
 * will be returned.
 * For example,
 * <code>uloc_toUnicodeLocaleType("Foo", "Bar")</code> returns "Bar",
 * <code>uloc_toUnicodeLocaleType("variableTop", "00A4")</code> returns "00A4".
 * 
 * @param keyword       the locale keyword (either legacy key such as
 *                      "collation" or BCP 47 Unicode locale extension
 *                      key such as "co").
 * @param value         the locale keyword value (either legacy type
 *                      such as "phonebook" or BCP 47 Unicode locale extension
 *                      type such as "phonebk").
 * @return              the well-formed BCP47 Unicode locale extension type,
 *                      or NULL if the locale keyword value cannot be mapped to
 *                      a well-formed BCP 47 Unicode locale extension type.
 * @see uloc_toLegacyType
 * @stable ICU 54
 */
U_CAPI const char* U_EXPORT2
uloc_toUnicodeLocaleType(const char* keyword, const char* value);

/**
 * Converts the specified keyword (BCP 47 Unicode locale extension key, or
 * legacy key) to the legacy key. For example, legacy key "collation" is
 * returned for the input BCP 47 Unicode locale extension key "co".
 * 
 * @param keyword       the input locale keyword (either BCP 47 Unicode locale
 *                      extension key or legacy key).
 * @return              the well-formed legacy key, or NULL if the specified
 *                      keyword cannot be mapped to a well-formed legacy key.
 * @see toUnicodeLocaleKey
 * @stable ICU 54
 */
U_CAPI const char* U_EXPORT2
uloc_toLegacyKey(const char* keyword);

/**
 * Converts the specified keyword value (BCP 47 Unicode locale extension type,
 * or legacy type or type alias) to the canonical legacy type. For example,
 * the legacy type "phonebook" is returned for the input BCP 47 Unicode
 * locale extension type "phonebk" with the keyword "collation" (or "co").
 * <p>
 * When the specified keyword is not recognized, but the specified value
 * satisfies the syntax of legacy key, or when the specified keyword
 * allows 'variable' type and the specified value satisfies the syntax,
 * then the pointer to the input type value itself will be returned.
 * For example,
 * <code>uloc_toLegacyType("Foo", "Bar")</code> returns "Bar",
 * <code>uloc_toLegacyType("vt", "00A4")</code> returns "00A4".
 *
 * @param keyword       the locale keyword (either legacy keyword such as
 *                      "collation" or BCP 47 Unicode locale extension
 *                      key such as "co").
 * @param value         the locale keyword value (either BCP 47 Unicode locale
 *                      extension type such as "phonebk" or legacy keyword value
 *                      such as "phonebook").
 * @return              the well-formed legacy type, or NULL if the specified
 *                      keyword value cannot be mapped to a well-formed legacy
 *                      type.
 * @see toUnicodeLocaleType
 * @stable ICU 54
 */
U_CAPI const char* U_EXPORT2
uloc_toLegacyType(const char* keyword, const char* value);

#endif /*_ULOC*/
