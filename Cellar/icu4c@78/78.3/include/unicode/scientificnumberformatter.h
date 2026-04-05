// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
* Copyright (c) 2014-2016, International Business Machines
* Corporation and others.  All Rights Reserved.
**********************************************************************
*/
#ifndef SCINUMBERFORMATTER_H
#define SCINUMBERFORMATTER_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING


#include "unicode/unistr.h"

/**
 * \file 
 * \brief C++ API: Formats in scientific notation.
 */

U_NAMESPACE_BEGIN

class FieldPositionIterator;
class DecimalFormatSymbols;
class DecimalFormat;
class Formattable;

/**
 * A formatter that formats numbers in user-friendly scientific notation.
 *
 * Sample code:
 * <pre>
 * UErrorCode status = U_ZERO_ERROR;
 * LocalPointer<ScientificNumberFormatter> fmt(
 *         ScientificNumberFormatter::createMarkupInstance(
 *                 "en", "<sup>", "</sup>", status));
 * if (U_FAILURE(status)) {
 *     return;
 * }
 * UnicodeString appendTo;
 * // appendTo = "1.23456x10<sup>-78</sup>"
 * fmt->format(1.23456e-78, appendTo, status);
 * </pre>
 *
 * @stable ICU 55
 */
class U_I18N_API ScientificNumberFormatter : public UObject {
public:

    /**
     * Creates a ScientificNumberFormatter instance that uses
     * superscript characters for exponents.
     * @param fmtToAdopt The DecimalFormat which must be configured for
     *   scientific notation.
     * @param status error returned here.
     * @return The new ScientificNumberFormatter instance.
     *
     * @stable ICU 55
     */
    static ScientificNumberFormatter *createSuperscriptInstance(
            DecimalFormat *fmtToAdopt, UErrorCode &status);

    /**
     * Creates a ScientificNumberFormatter instance that uses
     * superscript characters for exponents for this locale.
     * @param locale The locale
     * @param status error returned here.
     * @return The ScientificNumberFormatter instance.
     *
     * @stable ICU 55
     */
    static ScientificNumberFormatter *createSuperscriptInstance(
            const Locale &locale, UErrorCode &status);


    /**
     * Creates a ScientificNumberFormatter instance that uses
     * markup for exponents.
     * @param fmtToAdopt The DecimalFormat which must be configured for
     *   scientific notation.
     * @param beginMarkup the markup to start superscript.
     * @param endMarkup the markup to end superscript.
     * @param status error returned here.
     * @return The new ScientificNumberFormatter instance.
     *
     * @stable ICU 55
     */
    static ScientificNumberFormatter *createMarkupInstance(
            DecimalFormat *fmtToAdopt,
            const UnicodeString &beginMarkup,
            const UnicodeString &endMarkup,
            UErrorCode &status);

    /**
     * Creates a ScientificNumberFormatter instance that uses
     * markup for exponents for this locale.
     * @param locale The locale
     * @param beginMarkup the markup to start superscript.
     * @param endMarkup the markup to end superscript.
     * @param status error returned here.
     * @return The ScientificNumberFormatter instance.
     *
     * @stable ICU 55
     */
    static ScientificNumberFormatter *createMarkupInstance(
            const Locale &locale,
            const UnicodeString &beginMarkup,
            const UnicodeString &endMarkup,
            UErrorCode &status);


    /**
     * Returns a copy of this object. Caller must free returned copy.
     * @stable ICU 55
     */
    ScientificNumberFormatter *clone() const {
        return new ScientificNumberFormatter(*this);
    }

    /**
     * Destructor.
     * @stable ICU 55
     */
    virtual ~ScientificNumberFormatter();

    /**
     * Formats a number into user friendly scientific notation.
     *
     * @param number the number to format.
     * @param appendTo formatted string appended here.
     * @param status any error returned here.
     * @return appendTo
     *
     * @stable ICU 55
     */
    UnicodeString &format(
            const Formattable &number,
            UnicodeString &appendTo,
            UErrorCode &status) const;
 private:
    class U_I18N_API Style : public UObject {
    public:
        virtual Style *clone() const = 0;
    protected:
        virtual UnicodeString &format(
                const UnicodeString &original,
                FieldPositionIterator &fpi,
                const UnicodeString &preExponent,
                UnicodeString &appendTo,
                UErrorCode &status) const = 0;
    private:
        friend class ScientificNumberFormatter;
    };

    class U_I18N_API SuperscriptStyle : public Style {
    public:
        virtual SuperscriptStyle *clone() const override;
    protected:
        virtual UnicodeString &format(
                const UnicodeString &original,
                FieldPositionIterator &fpi,
                const UnicodeString &preExponent,
                UnicodeString &appendTo,
                UErrorCode &status) const override;
    };

    class U_I18N_API MarkupStyle : public Style {
    public:
        MarkupStyle(
                const UnicodeString &beginMarkup,
                const UnicodeString &endMarkup)
                : Style(),
                  fBeginMarkup(beginMarkup),
                  fEndMarkup(endMarkup) { }
        virtual MarkupStyle *clone() const override;
    protected:
        virtual UnicodeString &format(
                const UnicodeString &original,
                FieldPositionIterator &fpi,
                const UnicodeString &preExponent,
                UnicodeString &appendTo,
                UErrorCode &status) const override;
    private:
        UnicodeString fBeginMarkup;
        UnicodeString fEndMarkup;
    };

    ScientificNumberFormatter(
            DecimalFormat *fmtToAdopt,
            Style *styleToAdopt,
            UErrorCode &status);

    ScientificNumberFormatter(const ScientificNumberFormatter &other);
    ScientificNumberFormatter &operator=(const ScientificNumberFormatter &) = delete;

    static void getPreExponent(
            const DecimalFormatSymbols &dfs, UnicodeString &preExponent);

    static ScientificNumberFormatter *createInstance(
            DecimalFormat *fmtToAdopt,
            Style *styleToAdopt,
            UErrorCode &status);

    UnicodeString fPreExponent;
    DecimalFormat *fDecimalFormat;
    Style *fStyle;

};

U_NAMESPACE_END


#endif /* !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif 
