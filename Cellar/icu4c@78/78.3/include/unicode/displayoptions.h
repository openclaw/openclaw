// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __DISPLAYOPTIONS_H__
#define __DISPLAYOPTIONS_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

/**
 * \file
 * \brief C++ API: Display options class
 *
 * This class is designed as a more modern version of the UDisplayContext mechanism.
 */

#include "unicode/udisplayoptions.h"
#include "unicode/uversion.h"

U_NAMESPACE_BEGIN

/**
 * Represents all the display options that are supported by CLDR such as grammatical case, noun
 * class, ... etc. It currently supports enums, but may be extended in the future to have other
 * types of data. It replaces a DisplayContext[] as a method parameter.
 *
 * NOTE: This class is Immutable, and uses a Builder interface.
 *
 * For example:
 * ```
 * DisplayOptions x =
 *     DisplayOptions::builder().
 *         .setGrammaticalCase(UDISPOPT_GRAMMATICAL_CASE_DATIVE)
 *         .setPluralCategory(UDISPOPT_PLURAL_CATEGORY_FEW)
 *         .build();
 * ```
 *
 * @stable ICU 72
 */
class U_I18N_API DisplayOptions {
public:
    /**
     * Responsible for building `DisplayOptions`.
     *
     * @stable ICU 72
     */
    class U_I18N_API Builder {
    public:
        /**
         * Sets the grammatical case.
         *
         * @param grammaticalCase The grammatical case.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setGrammaticalCase(UDisplayOptionsGrammaticalCase grammaticalCase) {
            this->grammaticalCase = grammaticalCase;
            return *this;
        }

        /**
         * Sets the noun class.
         *
         * @param nounClass The noun class.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setNounClass(UDisplayOptionsNounClass nounClass) {
            this->nounClass = nounClass;
            return *this;
        }

        /**
         * Sets the plural category.
         *
         * @param pluralCategory The plural category.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setPluralCategory(UDisplayOptionsPluralCategory pluralCategory) {
            this->pluralCategory = pluralCategory;
            return *this;
        }

        /**
         * Sets the capitalization.
         *
         * @param capitalization The capitalization.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setCapitalization(UDisplayOptionsCapitalization capitalization) {
            this->capitalization = capitalization;
            return *this;
        }

        /**
         * Sets the dialect handling.
         *
         * @param nameStyle The name style.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setNameStyle(UDisplayOptionsNameStyle nameStyle) {
            this->nameStyle = nameStyle;
            return *this;
        }

        /**
         * Sets the display length.
         *
         * @param displayLength The display length.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setDisplayLength(UDisplayOptionsDisplayLength displayLength) {
            this->displayLength = displayLength;
            return *this;
        }

        /**
         * Sets the substitute handling.
         *
         * @param substituteHandling The substitute handling.
         * @return Builder
         * @stable ICU 72
         */
        Builder &setSubstituteHandling(UDisplayOptionsSubstituteHandling substituteHandling) {
            this->substituteHandling = substituteHandling;
            return *this;
        }

        /**
         * Builds the display options.
         *
         * @return DisplayOptions
         * @stable ICU 72
         */
        DisplayOptions build() { return DisplayOptions(*this); }

    private:
        friend DisplayOptions;

        Builder();
        Builder(const DisplayOptions &displayOptions);

        UDisplayOptionsGrammaticalCase grammaticalCase;
        UDisplayOptionsNounClass nounClass;
        UDisplayOptionsPluralCategory pluralCategory;
        UDisplayOptionsCapitalization capitalization;
        UDisplayOptionsNameStyle nameStyle;
        UDisplayOptionsDisplayLength displayLength;
        UDisplayOptionsSubstituteHandling substituteHandling;
    };

    /**
     * Creates a builder with the `UNDEFINED` values for all the parameters.
     *
     * @return Builder
     * @stable ICU 72
     */
    static Builder builder();
    /**
     * Creates a builder with the same parameters from this object.
     *
     * @return Builder
     * @stable ICU 72
     */
    Builder copyToBuilder() const;
    /**
     * Gets the grammatical case.
     *
     * @return UDisplayOptionsGrammaticalCase
     * @stable ICU 72
     */
    UDisplayOptionsGrammaticalCase getGrammaticalCase() const { return grammaticalCase; }

    /**
     * Gets the noun class.
     *
     * @return UDisplayOptionsNounClass
     * @stable ICU 72
     */
    UDisplayOptionsNounClass getNounClass() const { return nounClass; }

    /**
     * Gets the plural category.
     *
     * @return UDisplayOptionsPluralCategory
     * @stable ICU 72
     */
    UDisplayOptionsPluralCategory getPluralCategory() const { return pluralCategory; }

    /**
     * Gets the capitalization.
     *
     * @return UDisplayOptionsCapitalization
     * @stable ICU 72
     */
    UDisplayOptionsCapitalization getCapitalization() const { return capitalization; }

    /**
     * Gets the dialect handling.
     *
     * @return UDisplayOptionsNameStyle
     * @stable ICU 72
     */
    UDisplayOptionsNameStyle getNameStyle() const { return nameStyle; }

    /**
     * Gets the display length.
     *
     * @return UDisplayOptionsDisplayLength
     * @stable ICU 72
     */
    UDisplayOptionsDisplayLength getDisplayLength() const { return displayLength; }

    /**
     * Gets the substitute handling.
     *
     * @return UDisplayOptionsSubstituteHandling
     * @stable ICU 72
     */
    UDisplayOptionsSubstituteHandling getSubstituteHandling() const { return substituteHandling; }

    /**
     * Copies the DisplayOptions.
     *
     * @param other The options to copy.
     * @stable ICU 72
     */
    DisplayOptions &operator=(const DisplayOptions &other) = default;

    /**
     * Moves the DisplayOptions.
     *
     * @param other The options to move from.
     * @stable ICU 72
     */
    DisplayOptions &operator=(DisplayOptions &&other) noexcept = default;

    /**
     * Copies the DisplayOptions.
     *
     * @param other The options to copy.
     * @stable ICU 72
     */
    DisplayOptions(const DisplayOptions &other) = default;

private:
    DisplayOptions(const Builder &builder);
    UDisplayOptionsGrammaticalCase grammaticalCase;
    UDisplayOptionsNounClass nounClass;
    UDisplayOptionsPluralCategory pluralCategory;
    UDisplayOptionsCapitalization capitalization;
    UDisplayOptionsNameStyle nameStyle;
    UDisplayOptionsDisplayLength displayLength;
    UDisplayOptionsSubstituteHandling substituteHandling;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __DISPLAYOPTIONS_H__
