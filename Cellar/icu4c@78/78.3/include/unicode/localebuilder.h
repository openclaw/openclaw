// © 2018 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
#ifndef __LOCALEBUILDER_H__
#define __LOCALEBUILDER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/locid.h"
#include "unicode/localematcher.h"
#include "unicode/stringpiece.h"
#include "unicode/uobject.h"

/**
 * \file
 * \brief C++ API: Builder API for Locale
 */

U_NAMESPACE_BEGIN
class FixedString;

/**
 * <code>LocaleBuilder</code> is used to build instances of <code>Locale</code>
 * from values configured by the setters.  Unlike the <code>Locale</code>
 * constructors, the <code>LocaleBuilder</code> checks if a value configured by a
 * setter satisfies the syntax requirements defined by the <code>Locale</code>
 * class.  A <code>Locale</code> object created by a <code>LocaleBuilder</code> is
 * well-formed and can be transformed to a well-formed IETF BCP 47 language tag
 * without losing information.
 *
 * <p>The following example shows how to create a <code>Locale</code> object
 * with the <code>LocaleBuilder</code>.
 * <blockquote>
 * <pre>
 *     UErrorCode status = U_ZERO_ERROR;
 *     Locale aLocale = LocaleBuilder()
 *                          .setLanguage("sr")
 *                          .setScript("Latn")
 *                          .setRegion("RS")
 *                          .build(status);
 *     if (U_SUCCESS(status)) {
 *       // ...
 *     }
 * </pre>
 * </blockquote>
 *
 * <p>LocaleBuilders can be reused; <code>clear()</code> resets all
 * fields to their default values.
 *
 * <p>LocaleBuilder tracks errors in an internal UErrorCode. For all setters,
 * except setLanguageTag and setLocale, LocaleBuilder will return immediately
 * if the internal UErrorCode is in error state.
 * To reset internal state and error code, call clear method.
 * The setLanguageTag and setLocale method will first clear the internal
 * UErrorCode, then track the error of the validation of the input parameter
 * into the internal UErrorCode.
 *
 * @stable ICU 64
 */
class U_COMMON_API LocaleBuilder : public UObject {
public:
    /**
     * Constructs an empty LocaleBuilder. The default value of all
     * fields, extensions, and private use information is the
     * empty string.
     *
     * @stable ICU 64
     */
    LocaleBuilder();

    /**
     * Destructor
     * @stable ICU 64
     */
    virtual ~LocaleBuilder();

    /**
     * Resets the <code>LocaleBuilder</code> to match the provided
     * <code>locale</code>.  Existing state is discarded.
     *
     * <p>All fields of the locale must be well-formed.
     * <p>This method clears the internal UErrorCode.
     *
     * @param locale the locale
     * @return This builder.
     *
     * @stable ICU 64
     */
    LocaleBuilder& setLocale(const Locale& locale);

    /**
     * Resets the LocaleBuilder to match the provided IETF BCP 47 language tag.
     * Discards the existing state.
     * The empty string causes the builder to be reset, like {@link #clear}.
     * Legacy language tags (marked as “Type: grandfathered” in BCP 47)
     * are converted to their canonical form before being processed.
     * Otherwise, the <code>language tag</code> must be well-formed,
     * or else the build() method will later report an U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p>This method clears the internal UErrorCode.
     *
     * @param tag the language tag, defined as IETF BCP 47 language tag.
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setLanguageTag(StringPiece tag);

    /**
     * Sets the language.  If <code>language</code> is the empty string, the
     * language in this <code>LocaleBuilder</code> is removed. Otherwise, the
     * <code>language</code> must be well-formed, or else the build() method will
     * later report an U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p>The syntax of language value is defined as
     * [unicode_language_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_language_subtag).
     *
     * @param language the language
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setLanguage(StringPiece language);

    /**
     * Sets the script. If <code>script</code> is the empty string, the script in
     * this <code>LocaleBuilder</code> is removed.
     * Otherwise, the <code>script</code> must be well-formed, or else the build()
     * method will later report an U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p>The script value is a four-letter script code as
     * [unicode_script_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_script_subtag)
     * defined by ISO 15924
     *
     * @param script the script
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setScript(StringPiece script);

    /**
     * Sets the region.  If region is the empty string, the region in this
     * <code>LocaleBuilder</code> is removed. Otherwise, the <code>region</code>
     * must be well-formed, or else the build() method will later report an
     * U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p>The region value is defined by
     *  [unicode_region_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_region_subtag)
     * as a two-letter ISO 3166 code or a three-digit UN M.49 area code.
     *
     * <p>The region value in the <code>Locale</code> created by the
     * <code>LocaleBuilder</code> is always normalized to upper case.
     *
     * @param region the region
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setRegion(StringPiece region);

    /**
     * Sets the variant.  If variant is the empty string, the variant in this
     * <code>LocaleBuilder</code> is removed.  Otherwise, the <code>variant</code>
     * must be well-formed, or else the build() method will later report an
     * U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p><b>Note:</b> This method checks if <code>variant</code>
     * satisfies the
     * [unicode_variant_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_variant_subtag)
     * syntax requirements, and normalizes the value to lowercase letters. However,
     * the <code>Locale</code> class does not impose any syntactic
     * restriction on variant. To set an ill-formed variant, use a Locale constructor.
     * If there are multiple unicode_variant_subtag, the caller must concatenate
     * them with '-' as separator (ex: "foobar-fibar").
     *
     * @param variant the variant
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setVariant(StringPiece variant);

    /**
     * Sets the extension for the given key. If the value is the empty string,
     * the extension is removed.  Otherwise, the <code>key</code> and
     * <code>value</code> must be well-formed, or else the build() method will
     * later report an U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p><b>Note:</b> The key ('u') is used for the Unicode locale extension.
     * Setting a value for this key replaces any existing Unicode locale key/type
     * pairs with those defined in the extension.
     *
     * <p><b>Note:</b> The key ('x') is used for the private use code. To be
     * well-formed, the value for this key needs only to have subtags of one to
     * eight alphanumeric characters, not two to eight as in the general case.
     *
     * @param key the extension key
     * @param value the extension value
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setExtension(char key, StringPiece value);

    /**
     * Sets the Unicode locale keyword type for the given key. If the type
     * StringPiece is constructed with a nullptr, the keyword is removed.
     * If the type is the empty string, the keyword is set without type subtags.
     * Otherwise, the key and type must be well-formed, or else the build()
     * method will later report an U_ILLEGAL_ARGUMENT_ERROR.
     *
     * <p>Keys and types are converted to lower case.
     *
     * <p><b>Note</b>:Setting the 'u' extension via {@link #setExtension}
     * replaces all Unicode locale keywords with those defined in the
     * extension.
     *
     * @param key the Unicode locale key
     * @param type the Unicode locale type
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& setUnicodeLocaleKeyword(
        StringPiece key, StringPiece type);

    /**
     * Adds a unicode locale attribute, if not already present, otherwise
     * has no effect.  The attribute must not be empty string and must be
     * well-formed or U_ILLEGAL_ARGUMENT_ERROR will be set to status
     * during the build() call.
     *
     * @param attribute the attribute
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& addUnicodeLocaleAttribute(StringPiece attribute);

    /**
     * Removes a unicode locale attribute, if present, otherwise has no
     * effect.  The attribute must not be empty string and must be well-formed
     * or U_ILLEGAL_ARGUMENT_ERROR will be set to status during the build() call.
     *
     * <p>Attribute comparison for removal is case-insensitive.
     *
     * @param attribute the attribute
     * @return This builder.
     * @stable ICU 64
     */
    LocaleBuilder& removeUnicodeLocaleAttribute(StringPiece attribute);

    /**
     * Resets the builder to its initial, empty state.
     * <p>This method clears the internal UErrorCode.
     *
     * @return this builder
     * @stable ICU 64
     */
    LocaleBuilder& clear();

    /**
     * Resets the extensions to their initial, empty state.
     * Language, script, region and variant are unchanged.
     *
     * @return this builder
     * @stable ICU 64
     */
    LocaleBuilder& clearExtensions();

    /**
     * Returns an instance of <code>Locale</code> created from the fields set
     * on this builder.
     * If any set methods or during the build() call require memory allocation
     * but fail U_MEMORY_ALLOCATION_ERROR will be set to status.
     * If any of the fields set by the setters are not well-formed, the status
     * will be set to U_ILLEGAL_ARGUMENT_ERROR. The state of the builder will
     * not change after the build() call and the caller is free to keep using
     * the same builder to build more locales.
     *
     * @return a new Locale
     * @stable ICU 64
     */
    Locale build(UErrorCode& status);

    /**
     * Sets the UErrorCode if an error occurred while recording sets.
     * Preserves older error codes in the outErrorCode.
     * @param outErrorCode Set to an error code that occurred while setting subtags.
     *                  Unchanged if there is no such error or if outErrorCode
     *                  already contained an error.
     * @return true if U_FAILURE(outErrorCode)
     * @stable ICU 65
     */
    UBool copyErrorTo(UErrorCode &outErrorCode) const;

private:
    friend class LocaleMatcher::Result;

    void copyExtensionsFrom(const Locale& src, UErrorCode& errorCode);

    UErrorCode status_;
    char language_[9];
    char script_[5];
    char region_[4];
    FixedString *variant_;  // Pointer not object so we need not #include internal fixedstring.h.
    icu::Locale *extensions_;  // Pointer not object. Storage for all other fields.

};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // __LOCALEBUILDER_H__
