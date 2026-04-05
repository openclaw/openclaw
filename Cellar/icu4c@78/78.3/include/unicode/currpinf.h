// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2009-2015, International Business Machines Corporation and    *
 * others. All Rights Reserved.                                                *
 *******************************************************************************
 */
#ifndef CURRPINF_H
#define CURRPINF_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Currency Plural Information used by Decimal Format
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/unistr.h"

U_NAMESPACE_BEGIN

class Locale;
class PluralRules;
class Hashtable;

/**
 * This class represents the information needed by 
 * DecimalFormat to format currency plural, 
 * such as "3.00 US dollars" or "1.00 US dollar". 
 * DecimalFormat creates for itself an instance of
 * CurrencyPluralInfo from its locale data.  
 * If you need to change any of these symbols, you can get the
 * CurrencyPluralInfo object from your 
 * DecimalFormat and modify it.
 *
 * Following are the information needed for currency plural format and parse:
 * locale information,
 * plural rule of the locale,
 * currency plural pattern of the locale.
 *
 * @stable ICU 4.2
 */
class  U_I18N_API CurrencyPluralInfo : public UObject {
public:

    /**
     * Create a CurrencyPluralInfo object for the default locale.
     * @param status output param set to success/failure code on exit
     * @stable ICU 4.2
     */
    CurrencyPluralInfo(UErrorCode& status);

    /**
     * Create a CurrencyPluralInfo object for the given locale.
     * @param locale the locale
     * @param status output param set to success/failure code on exit
     * @stable ICU 4.2
     */
    CurrencyPluralInfo(const Locale& locale, UErrorCode& status); 

    /**
     * Copy constructor
     *
     * @stable ICU 4.2
     */
    CurrencyPluralInfo(const CurrencyPluralInfo& info);


    /**
     * Assignment operator
     *
     * @stable ICU 4.2
     */
    CurrencyPluralInfo& operator=(const CurrencyPluralInfo& info);


    /**
     * Destructor
     *
     * @stable ICU 4.2
     */
    virtual ~CurrencyPluralInfo();


    /**
     * Equal operator.
     *
     * @stable ICU 4.2
     */
    bool operator==(const CurrencyPluralInfo& info) const;


    /**
     * Not equal operator
     *
     * @stable ICU 4.2
     */
    bool operator!=(const CurrencyPluralInfo& info) const;


    /**
     * Clone
     *
     * @stable ICU 4.2
     */
    CurrencyPluralInfo* clone() const;


    /**
     * Gets plural rules of this locale, used for currency plural format
     *
     * @return plural rule
     * @stable ICU 4.2
     */
    const PluralRules* getPluralRules() const;

    /**
     * Given a plural count, gets currency plural pattern of this locale, 
     * used for currency plural format
     *
     * @param  pluralCount currency plural count
     * @param  result      output param to receive the pattern
     * @return a currency plural pattern based on plural count
     * @stable ICU 4.2
     */
    UnicodeString& getCurrencyPluralPattern(const UnicodeString& pluralCount,
                                            UnicodeString& result) const; 

    /**
     * Get locale 
     *
     * @return locale
     * @stable ICU 4.2
     */
    const Locale& getLocale() const;

    /**
     * Set plural rules.
     * The plural rule is set when CurrencyPluralInfo
     * instance is created.
     * You can call this method to reset plural rules only if you want
     * to modify the default plural rule of the locale.
     *
     * @param ruleDescription new plural rule description
     * @param status output param set to success/failure code on exit
     * @stable ICU 4.2
     */
    void setPluralRules(const UnicodeString& ruleDescription,
                        UErrorCode& status);

    /**
     * Set currency plural pattern.
     * The currency plural pattern is set when CurrencyPluralInfo
     * instance is created.
     * You can call this method to reset currency plural pattern only if 
     * you want to modify the default currency plural pattern of the locale.
     *
     * @param pluralCount the plural count for which the currency pattern will 
     *                    be overridden.
     * @param pattern     the new currency plural pattern
     * @param status      output param set to success/failure code on exit
     * @stable ICU 4.2
     */
    void setCurrencyPluralPattern(const UnicodeString& pluralCount, 
                                  const UnicodeString& pattern,
                                  UErrorCode& status);

    /**
     * Set locale
     *
     * @param loc     the new locale to set
     * @param status  output param set to success/failure code on exit
     * @stable ICU 4.2
     */
    void setLocale(const Locale& loc, UErrorCode& status);

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 4.2
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 4.2
     */
    static UClassID U_EXPORT2 getStaticClassID();

private:
    friend class DecimalFormat;
    friend class DecimalFormatImpl;

    void initialize(const Locale& loc, UErrorCode& status);
   
    void setupCurrencyPluralPattern(const Locale& loc, UErrorCode& status);

    /*
     * delete hash table
     *
     * @param hTable  hash table to be deleted
     */
    void deleteHash(Hashtable* hTable);


    /*
     * initialize hash table
     *
     * @param status   output param set to success/failure code on exit
     * @return         hash table initialized
     */
    Hashtable* initHash(UErrorCode& status);



    /**
     * copy hash table
     *
     * @param source   the source to copy from
     * @param target   the target to copy to
     * @param status   error code
     */
    void copyHash(const Hashtable* source, Hashtable* target, UErrorCode& status);

    //-------------------- private data member ---------------------
    // map from plural count to currency plural pattern, for example
    // a plural pattern defined in "CurrencyUnitPatterns" is
    // "one{{0} {1}}", in which "one" is a plural count
    // and "{0} {1}" is a currency plural pattern".
    // The currency plural pattern saved in this mapping is the pattern
    // defined in "CurrencyUnitPattern" by replacing
    // {0} with the number format pattern,
    // and {1} with 3 currency sign.
    Hashtable* fPluralCountToCurrencyUnitPattern;

    /*
     * The plural rule is used to format currency plural name,
     * for example: "3.00 US Dollars".
     * If there are 3 currency signs in the currency pattern,
     * the 3 currency signs will be replaced by currency plural name.
     */
    PluralRules* fPluralRules;

    // locale
    Locale* fLocale;

private:
    /**
    * An internal status variable used to indicate that the object is in an 'invalid' state.
    * Used by copy constructor, the assignment operator and the clone method.
    */
    UErrorCode fInternalStatus;
};


inline bool
CurrencyPluralInfo::operator!=(const CurrencyPluralInfo& info) const {
    return !operator==(info);
}  

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _CURRPINFO
//eof
