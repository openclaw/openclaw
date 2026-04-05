// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2008-2014, Google, International Business Machines Corporation
 * and others. All Rights Reserved.
 *******************************************************************************
 */

#ifndef __TMUTFMT_H__
#define __TMUTFMT_H__

#include "unicode/utypes.h"

/**
 * \file
 * \brief C++ API: Format and parse duration in single time unit
 */


#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/unistr.h"
#include "unicode/tmunit.h"
#include "unicode/tmutamt.h"
#include "unicode/measfmt.h"
#include "unicode/numfmt.h"
#include "unicode/plurrule.h"

#ifndef U_HIDE_DEPRECATED_API

/**
 * Constants for various styles.
 * There are 2 styles: full name and abbreviated name.
 * For example, for English, the full name for hour duration is "3 hours",
 * and the abbreviated name is "3 hrs".
 * @deprecated ICU 53 Use MeasureFormat and UMeasureFormatWidth instead.
 */
enum UTimeUnitFormatStyle {
    /** @deprecated ICU 53 */
    UTMUTFMT_FULL_STYLE,
    /** @deprecated ICU 53 */
    UTMUTFMT_ABBREVIATED_STYLE,
    /** @deprecated ICU 53 */
    UTMUTFMT_FORMAT_STYLE_COUNT
};
typedef enum UTimeUnitFormatStyle UTimeUnitFormatStyle; /**< @deprecated ICU 53 */


U_NAMESPACE_BEGIN

class Hashtable;
class UVector;

struct TimeUnitFormatReadSink;

/**
 * Format or parse a TimeUnitAmount, using plural rules for the units where available.
 *
 * <P>
 * Code Sample:
 * <pre>
 *   // create time unit amount instance - a combination of Number and time unit
 *   UErrorCode status = U_ZERO_ERROR;
 *   TimeUnitAmount* source = new TimeUnitAmount(2, TimeUnit::UTIMEUNIT_YEAR, status);
 *   // create time unit format instance
 *   TimeUnitFormat* format = new TimeUnitFormat(Locale("en"), status);
 *   // format a time unit amount
 *   UnicodeString formatted;
 *   Formattable formattable;
 *   if (U_SUCCESS(status)) {
 *       formattable.adoptObject(source);
 *       formatted = ((Format*)format)->format(formattable, formatted, status);
 *       Formattable result;
 *       ((Format*)format)->parseObject(formatted, result, status);
 *       if (U_SUCCESS(status)) {
 *           assert (result == formattable);
 *       }
 *   }
 * </pre>
 *
 * <P>
 * @see TimeUnitAmount
 * @see TimeUnitFormat
 * @deprecated ICU 53 Use the MeasureFormat class instead.
 */
class U_I18N_API TimeUnitFormat: public MeasureFormat {
public:

    /**
     * Create TimeUnitFormat with default locale, and full name style.
     * Use setLocale and/or setFormat to modify.
     * @deprecated ICU 53
     */
    TimeUnitFormat(UErrorCode& status);

    /**
     * Create TimeUnitFormat given locale, and full name style.
     * @deprecated ICU 53
     */
    TimeUnitFormat(const Locale& locale, UErrorCode& status);

    /**
     * Create TimeUnitFormat given locale and style.
     * @deprecated ICU 53
     */
    TimeUnitFormat(const Locale& locale, UTimeUnitFormatStyle style, UErrorCode& status);

    /**
     * Copy constructor.
     * @deprecated ICU 53
     */
    TimeUnitFormat(const TimeUnitFormat&);

    /**
     * deconstructor
     * @deprecated ICU 53
     */
    virtual ~TimeUnitFormat();

    /**
     * Clone this Format object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return    A copy of the object.
     * @deprecated ICU 53
     */
    virtual TimeUnitFormat* clone() const override;

    /**
     * Assignment operator
     * @deprecated ICU 53
     */
    TimeUnitFormat& operator=(const TimeUnitFormat& other);

    /**
     * Set the locale used for formatting or parsing.
     * @param locale  the locale to be set
     * @param status  output param set to success/failure code on exit
     * @deprecated ICU 53
     */
    void setLocale(const Locale& locale, UErrorCode& status);


    /**
     * Set the number format used for formatting or parsing.
     * @param format  the number formatter to be set
     * @param status  output param set to success/failure code on exit
     * @deprecated ICU 53
     */
    void setNumberFormat(const NumberFormat& format, UErrorCode& status);

    /**
     * Parse a TimeUnitAmount.
     * @see Format#parseObject(const UnicodeString&, Formattable&, ParsePosition&) const;
     * @deprecated ICU 53
     */
    virtual void parseObject(const UnicodeString& source,
                             Formattable& result,
                             ParsePosition& pos) const override;

    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @deprecated ICU 53
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @deprecated ICU 53
     */
    virtual UClassID getDynamicClassID() const override;

private:
    Hashtable*    fTimeUnitToCountToPatterns[TimeUnit::UTIMEUNIT_FIELD_COUNT];
    UTimeUnitFormatStyle fStyle;

    void create(UTimeUnitFormatStyle style, UErrorCode& status);

    // it might actually be simpler to make them Decimal Formats later.
    // initialize all private data members
    void setup(UErrorCode& status);

    // initialize data member without fill in data for fTimeUnitToCountToPattern
    void initDataMembers(UErrorCode& status);

    // initialize fTimeUnitToCountToPatterns from current locale's resource.
    void readFromCurrentLocale(UTimeUnitFormatStyle style, const char* key, const UVector& pluralCounts,
                               UErrorCode& status);

    // check completeness of fTimeUnitToCountToPatterns against all time units,
    // and all plural rules, fill in fallback as necessary.
    void checkConsistency(UTimeUnitFormatStyle style, const char* key, UErrorCode& status);

    // fill in fTimeUnitToCountToPatterns from locale fall-back chain
    void searchInLocaleChain(UTimeUnitFormatStyle style, const char* key, const char* localeName,
                             TimeUnit::UTimeUnitFields field, const UnicodeString&,
                             const char*, Hashtable*, UErrorCode&);

    // initialize hash table
    Hashtable* initHash(UErrorCode& status);

    // delete hash table
    void deleteHash(Hashtable* htable);

    // copy hash table
    void copyHash(const Hashtable* source, Hashtable* target, UErrorCode& status);
    // get time unit name, such as "year", from time unit field enum, such as
    // UTIMEUNIT_YEAR.
    static const char* getTimeUnitName(TimeUnit::UTimeUnitFields field, UErrorCode& status);

    friend struct TimeUnitFormatReadSink;
};

U_NAMESPACE_END

#endif /* U_HIDE_DEPRECATED_API */
#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __TMUTFMT_H__
//eof
