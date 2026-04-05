// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File DCFMTSYM.H
*
* Modification History:
*
*   Date        Name        Description
*   02/19/97    aliu        Converted from java.
*   03/18/97    clhuang     Updated per C++ implementation.
*   03/27/97    helena      Updated to pass the simple test after code review.
*   08/26/97    aliu        Added currency/intl currency symbol support.
*   07/22/98    stephen     Changed to match C++ style
*                            currencySymbol -> fCurrencySymbol
*                            Constants changed from CAPS to kCaps
*   06/24/99    helena      Integrated Alan's NF enhancements and Java2 bug fixes
*   09/22/00    grhoten     Marked deprecation tags with a pointer to replacement
*                            functions.
********************************************************************************
*/

#ifndef DCFMTSYM_H
#define DCFMTSYM_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uchar.h"
#include "unicode/uobject.h"
#include "unicode/locid.h"
#include "unicode/numsys.h"
#include "unicode/unum.h"
#include "unicode/unistr.h"

/**
 * \file
 * \brief C++ API: Symbols for formatting numbers.
 */


U_NAMESPACE_BEGIN

/**
 * This class represents the set of symbols needed by DecimalFormat
 * to format numbers. DecimalFormat creates for itself an instance of
 * DecimalFormatSymbols from its locale data.  If you need to change any
 * of these symbols, you can get the DecimalFormatSymbols object from
 * your DecimalFormat and modify it.
 * <P>
 * Here are the special characters used in the parts of the
 * subpattern, with notes on their usage.
 * <pre>
 * \code
 *        Symbol   Meaning
 *          0      a digit
 *          #      a digit, zero shows as absent
 *          .      placeholder for decimal separator
 *          ,      placeholder for grouping separator.
 *          ;      separates formats.
 *          -      default negative prefix.
 *          %      divide by 100 and show as percentage
 *          X      any other characters can be used in the prefix or suffix
 *          '      used to quote special characters in a prefix or suffix.
 * \endcode
 *  </pre>
 * [Notes]
 * <P>
 * If there is no explicit negative subpattern, - is prefixed to the
 * positive form. That is, "0.00" alone is equivalent to "0.00;-0.00".
 * <P>
 * The grouping separator is commonly used for thousands, but in some
 * countries for ten-thousands. The interval is a constant number of
 * digits between the grouping characters, such as 100,000,000 or 1,0000,0000.
 * If you supply a pattern with multiple grouping characters, the interval
 * between the last one and the end of the integer is the one that is
 * used. So "#,##,###,####" == "######,####" == "##,####,####".
 */
class U_I18N_API_CLASS DecimalFormatSymbols : public UObject {
public:
    /**
     * Constants for specifying a number format symbol.
     * @stable ICU 2.0
     */
    enum ENumberFormatSymbol {
        /** The decimal separator */
        kDecimalSeparatorSymbol,
        /** The grouping separator */
        kGroupingSeparatorSymbol,
        /** The pattern separator */
        kPatternSeparatorSymbol,
        /** The percent sign */
        kPercentSymbol,
        /** Zero*/
        kZeroDigitSymbol,
        /** Character representing a digit in the pattern */
        kDigitSymbol,
        /** The minus sign */
        kMinusSignSymbol,
        /** The plus sign */
        kPlusSignSymbol,
        /** The currency symbol */
        kCurrencySymbol,
        /** The international currency symbol */
        kIntlCurrencySymbol,
        /** The monetary separator */
        kMonetarySeparatorSymbol,
        /** The exponential symbol */
        kExponentialSymbol,
        /** Per mill symbol - replaces kPermillSymbol */
        kPerMillSymbol,
        /** Escape padding character */
        kPadEscapeSymbol,
        /** Infinity symbol */
        kInfinitySymbol,
        /** Nan symbol */
        kNaNSymbol,
        /** Significant digit symbol
         * @stable ICU 3.0 */
        kSignificantDigitSymbol,
        /** The monetary grouping separator
         * @stable ICU 3.6
         */
        kMonetaryGroupingSeparatorSymbol,
        /** One
         * @stable ICU 4.6
         */
        kOneDigitSymbol,
        /** Two
         * @stable ICU 4.6
         */
        kTwoDigitSymbol,
        /** Three
         * @stable ICU 4.6
         */
        kThreeDigitSymbol,
        /** Four
         * @stable ICU 4.6
         */
        kFourDigitSymbol,
        /** Five
         * @stable ICU 4.6
         */
        kFiveDigitSymbol,
        /** Six
         * @stable ICU 4.6
         */
        kSixDigitSymbol,
        /** Seven
         * @stable ICU 4.6
         */
        kSevenDigitSymbol,
        /** Eight
         * @stable ICU 4.6
         */
        kEightDigitSymbol,
        /** Nine
         * @stable ICU 4.6
         */
        kNineDigitSymbol,
        /** Multiplication sign.
         * @stable ICU 54
         */
        kExponentMultiplicationSymbol,
#ifndef U_HIDE_INTERNAL_API
        /** Approximately sign.
         * @internal
         */
        kApproximatelySignSymbol,
#endif  /* U_HIDE_INTERNAL_API */
        /** count symbol constants */
        kFormatSymbolCount = kExponentMultiplicationSymbol + 2
    };

    /**
     * Create a DecimalFormatSymbols object for the given locale.
     *
     * @param locale    The locale to get symbols for.
     * @param status    Input/output parameter, set to success or
     *                  failure code upon return.
     * @stable ICU 2.0
     */
    U_I18N_API DecimalFormatSymbols(const Locale& locale, UErrorCode& status);

    /**
     * Creates a DecimalFormatSymbols instance for the given locale with digits and symbols
     * corresponding to the given NumberingSystem.
     *
     * This constructor behaves equivalently to the normal constructor called with a locale having a
     * "numbers=xxxx" keyword specifying the numbering system by name.
     *
     * In this constructor, the NumberingSystem argument will be used even if the locale has its own
     * "numbers=xxxx" keyword.
     *
     * @param locale    The locale to get symbols for.
     * @param ns        The numbering system.
     * @param status    Input/output parameter, set to success or
     *                  failure code upon return.
     * @stable ICU 60
     */
    U_I18N_API DecimalFormatSymbols(const Locale& locale, const NumberingSystem& ns, UErrorCode& status);

    /**
     * Create a DecimalFormatSymbols object for the default locale.
     * This constructor will not fail.  If the resource file data is
     * not available, it will use hard-coded last-resort data and
     * set status to U_USING_FALLBACK_ERROR.
     *
     * @param status    Input/output parameter, set to success or
     *                  failure code upon return.
     * @stable ICU 2.0
     */
    U_I18N_API DecimalFormatSymbols(UErrorCode& status);

    /**
     * Creates a DecimalFormatSymbols object with last-resort data.
     * Intended for callers who cache the symbols data and
     * set all symbols on the resulting object.
     *
     * The last-resort symbols are similar to those for the root data,
     * except that the grouping separators are empty,
     * the NaN symbol is U+FFFD rather than "NaN",
     * and the CurrencySpacing patterns are empty.
     *
     * @param status    Input/output parameter, set to success or
     *                  failure code upon return.
     * @return last-resort symbols
     * @stable ICU 52
     */
    U_I18N_API static DecimalFormatSymbols* createWithLastResortData(UErrorCode& status);

    /**
     * Copy constructor.
     * @stable ICU 2.0
     */
    U_I18N_API DecimalFormatSymbols(const DecimalFormatSymbols&);

    /**
     * Assignment operator.
     * @stable ICU 2.0
     */
    U_I18N_API DecimalFormatSymbols& operator=(const DecimalFormatSymbols&);

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~DecimalFormatSymbols();

    /**
     * Return true if another object is semantically equal to this one.
     *
     * @param other    the object to be compared with.
     * @return         true if another object is semantically equal to this one.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator==(const DecimalFormatSymbols& other) const;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the object to be compared with.
     * @return         true if another object is semantically unequal to this one.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator!=(const DecimalFormatSymbols& other) const { return !operator==(other); }

    /**
     * Get one of the format symbols by its enum constant.
     * Each symbol is stored as a string so that graphemes
     * (characters with modifier letters) can be used.
     *
     * @param symbol    Constant to indicate a number format symbol.
     * @return    the format symbols by the param 'symbol'
     * @stable ICU 2.0
     */
    U_I18N_API inline UnicodeString getSymbol(ENumberFormatSymbol symbol) const;

    /**
     * Set one of the format symbols by its enum constant.
     * Each symbol is stored as a string so that graphemes
     * (characters with modifier letters) can be used.
     *
     * @param symbol    Constant to indicate a number format symbol.
     * @param value     value of the format symbol
     * @param propagateDigits If false, setting the zero digit will not automatically set 1-9.
     *     The default behavior is to automatically set 1-9 if zero is being set and the value
     *     it is being set to corresponds to a known Unicode zero digit.
     * @stable ICU 2.0
     */
    U_I18N_API void setSymbol(ENumberFormatSymbol symbol,
                              const UnicodeString& value,
                              const UBool propagateDigits);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Loads symbols for the specified currency into this instance.
     *
     * This method is internal. If you think it should be public, file a ticket.
     *
     * @internal
     */
    U_I18N_API void setCurrency(const char16_t* currency, UErrorCode& status);
#endif  // U_HIDE_INTERNAL_API

    /**
     * Returns the locale for which this object was constructed.
     * @stable ICU 2.6
     */
    U_I18N_API inline Locale getLocale() const;

    /**
     * Returns the locale for this object. Two flavors are available:
     * valid and actual locale.
     * @stable ICU 2.8
     */
    U_I18N_API Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const;

    /**
      * Get pattern string for 'CurrencySpacing' that can be applied to
      * currency format.
      * This API gets the CurrencySpacing data from ResourceBundle. The pattern can
      * be empty if there is no data from current locale and its parent locales.
      *
      * @param type :  UNUM_CURRENCY_MATCH, UNUM_CURRENCY_SURROUNDING_MATCH or UNUM_CURRENCY_INSERT.
      * @param beforeCurrency : true if the pattern is for before currency symbol.
      *                         false if the pattern is for after currency symbol.
      * @param status: Input/output parameter, set to success or
      *                  failure code upon return.
      * @return pattern string for currencyMatch, surroundingMatch or spaceInsert.
      *     Return empty string if there is no data for this locale and its parent
      *     locales.
      * @stable ICU 4.8
      */
    U_I18N_API const UnicodeString& getPatternForCurrencySpacing(UCurrencySpacing type,
                                                                 UBool beforeCurrency,
                                                                 UErrorCode& status) const;

    /**
      * Set pattern string for 'CurrencySpacing' that can be applied to
      * currency format.
      *
      * @param type : UNUM_CURRENCY_MATCH, UNUM_CURRENCY_SURROUNDING_MATCH or UNUM_CURRENCY_INSERT.
      * @param beforeCurrency : true if the pattern is for before currency symbol.
      *                         false if the pattern is for after currency symbol.
      * @param pattern : pattern string to override current setting.
      * @stable ICU 4.8
      */
    U_I18N_API void setPatternForCurrencySpacing(UCurrencySpacing type,
                                                 UBool beforeCurrency,
                                                 const UnicodeString& pattern);

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.2
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.2
     */
    U_I18N_API static UClassID getStaticClassID();

private:
    DecimalFormatSymbols();

    /**
     * Initializes the symbols from the LocaleElements resource bundle.
     * Note: The organization of LocaleElements badly needs to be
     * cleaned up.
     *
     * @param locale               The locale to get symbols for.
     * @param success              Input/output parameter, set to success or
     *                             failure code upon return.
     * @param useLastResortData    determine if use last resort data
     * @param ns                   The NumberingSystem to use; otherwise, fall
     *                             back to the locale.
     */
    void initialize(const Locale& locale, UErrorCode& success,
                    UBool useLastResortData = false, const NumberingSystem* ns = nullptr);

    /**
     * Initialize the symbols with default values.
     */
    void initialize();

public:

#ifndef U_HIDE_INTERNAL_API
    /**
     * @internal For ICU use only
     */
    U_I18N_API inline UBool isCustomCurrencySymbol() const {
        return fIsCustomCurrencySymbol;
    }

    /**
     * @internal For ICU use only
     */
    U_I18N_API inline UBool isCustomIntlCurrencySymbol() const {
        return fIsCustomIntlCurrencySymbol;
    }

    /**
     * @internal For ICU use only
     */
    U_I18N_API inline UChar32 getCodePointZero() const {
        return fCodePointZero;
    }
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * _Internal_ function - more efficient version of getSymbol,
     * returning a const reference to one of the symbol strings.
     * The returned reference becomes invalid when the symbol is changed
     * or when the DecimalFormatSymbols are destroyed.
     * Note: moved \#ifndef U_HIDE_INTERNAL_API after this, since this is needed for inline in DecimalFormat
     *
     * This is not currently stable API, but if you think it should be stable,
     * post a comment on the following ticket and the ICU team will take a look:
     * https://unicode-org.atlassian.net/browse/ICU-13580
     *
     * @param symbol Constant to indicate a number format symbol.
     * @return the format symbol by the param 'symbol'
     * @internal
     */
    U_I18N_API inline const UnicodeString& getConstSymbol(ENumberFormatSymbol symbol) const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * Returns the const UnicodeString reference, like getConstSymbol,
     * corresponding to the digit with the given value.  This is equivalent
     * to accessing the symbol from getConstSymbol with the corresponding
     * key, such as kZeroDigitSymbol or kOneDigitSymbol.
     *
     * This is not currently stable API, but if you think it should be stable,
     * post a comment on the following ticket and the ICU team will take a look:
     * https://unicode-org.atlassian.net/browse/ICU-13580
     *
     * @param digit The digit, an integer between 0 and 9 inclusive.
     *              If outside the range 0 to 9, the zero digit is returned.
     * @return the format symbol for the given digit.
     * @internal This API is currently for ICU use only.
     */
    U_I18N_API inline const UnicodeString& getConstDigitSymbol(int32_t digit) const;

    /**
     * Returns that pattern stored in currency info. Internal API for use by NumberFormat API.
     * @internal
     */
    U_I18N_API inline const char16_t* getCurrencyPattern() const;

    /**
     * Returns the numbering system with which this DecimalFormatSymbols was initialized.
     * @internal
     */
    U_I18N_API inline const char* getNumberingSystemName() const;
#endif  /* U_HIDE_INTERNAL_API */

private:
    /**
     * Private symbol strings.
     * They are either loaded from a resource bundle or otherwise owned.
     * setSymbol() clones the symbol string.
     * Readonly aliases can only come from a resource bundle, so that we can always
     * use fastCopyFrom() with them.
     *
     * If DecimalFormatSymbols becomes subclassable and the status of fSymbols changes
     * from private to protected,
     * or when fSymbols can be set any other way that allows them to be readonly aliases
     * to non-resource bundle strings,
     * then regular UnicodeString copies must be used instead of fastCopyFrom().
     *
     */
    UnicodeString fSymbols[kFormatSymbolCount];

    /**
     * Non-symbol variable for getConstSymbol(). Always empty.
     */
    UnicodeString fNoSymbol;

    /**
     * Dealing with code points is faster than dealing with strings when formatting. Because of
     * this, we maintain a value containing the zero code point that is used whenever digitStrings
     * represents a sequence of ten code points in order.
     *
     * <p>If the value stored here is positive, it means that the code point stored in this value
     * corresponds to the digitStrings array, and codePointZero can be used instead of the
     * digitStrings array for the purposes of efficient formatting; if -1, then digitStrings does
     * *not* contain a sequence of code points, and it must be used directly.
     *
     * <p>It is assumed that codePointZero always shadows the value in digitStrings. codePointZero
     * should never be set directly; rather, it should be updated only when digitStrings mutates.
     * That is, the flow of information is digitStrings -> codePointZero, not the other way.
     */
    UChar32 fCodePointZero;

    Locale locale;

    Locale actualLocale;
    Locale validLocale;
    const char16_t* currPattern = nullptr;

    UnicodeString currencySpcBeforeSym[UNUM_CURRENCY_SPACING_COUNT];
    UnicodeString currencySpcAfterSym[UNUM_CURRENCY_SPACING_COUNT];
    UBool fIsCustomCurrencySymbol;
    UBool fIsCustomIntlCurrencySymbol;
    char nsName[kInternalNumSysNameCapacity+1] = {};
};

// -------------------------------------

inline UnicodeString
DecimalFormatSymbols::getSymbol(ENumberFormatSymbol symbol) const {
    const UnicodeString *strPtr;
    if(symbol < kFormatSymbolCount) {
        strPtr = &fSymbols[symbol];
    } else {
        strPtr = &fNoSymbol;
    }
    return *strPtr;
}

// See comments above for this function. Not hidden with #ifdef U_HIDE_INTERNAL_API
inline const UnicodeString &
DecimalFormatSymbols::getConstSymbol(ENumberFormatSymbol symbol) const {
    const UnicodeString *strPtr;
    if(symbol < kFormatSymbolCount) {
        strPtr = &fSymbols[symbol];
    } else {
        strPtr = &fNoSymbol;
    }
    return *strPtr;
}

#ifndef U_HIDE_INTERNAL_API
inline const UnicodeString& DecimalFormatSymbols::getConstDigitSymbol(int32_t digit) const {
    if (digit < 0 || digit > 9) {
        digit = 0;
    }
    if (digit == 0) {
        return fSymbols[kZeroDigitSymbol];
    }
    ENumberFormatSymbol key = static_cast<ENumberFormatSymbol>(kOneDigitSymbol + digit - 1);
    return fSymbols[key];
}
#endif /* U_HIDE_INTERNAL_API */

// -------------------------------------

inline void
DecimalFormatSymbols::setSymbol(ENumberFormatSymbol symbol, const UnicodeString &value, const UBool propagateDigits = true) {
    if (symbol == kCurrencySymbol) {
        fIsCustomCurrencySymbol = true;
    }
    else if (symbol == kIntlCurrencySymbol) {
        fIsCustomIntlCurrencySymbol = true;
    }
    if(symbol<kFormatSymbolCount) {
        fSymbols[symbol]=value;
    }

    // If the zero digit is being set to a known zero digit according to Unicode,
    // then we automatically set the corresponding 1-9 digits
    // Also record updates to fCodePointZero. Be conservative if in doubt.
    if (symbol == kZeroDigitSymbol) {
        UChar32 sym = value.char32At(0);
        if ( propagateDigits && u_charDigitValue(sym) == 0 && value.countChar32() == 1 ) {
            fCodePointZero = sym;
            for ( int8_t i = 1 ; i<= 9 ; i++ ) {
                sym++;
                fSymbols[static_cast<int>(kOneDigitSymbol) + i - 1] = UnicodeString(sym);
            }
        } else {
            fCodePointZero = -1;
        }
    } else if (symbol >= kOneDigitSymbol && symbol <= kNineDigitSymbol) {
        fCodePointZero = -1;
    }
}

// -------------------------------------

inline Locale
DecimalFormatSymbols::getLocale() const {
    return locale;
}

#ifndef U_HIDE_INTERNAL_API
inline const char16_t*
DecimalFormatSymbols::getCurrencyPattern() const {
    return currPattern;
}
inline const char*
DecimalFormatSymbols::getNumberingSystemName() const {
    return nsName;
}
#endif /* U_HIDE_INTERNAL_API */

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _DCFMTSYM
//eof
