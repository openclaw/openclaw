// © 2023 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
#ifndef __ULOCBUILDER_H__
#define __ULOCBUILDER_H__

#include "unicode/localpointer.h"
#include "unicode/ulocale.h"
#include "unicode/utypes.h"

/**
 * \file
 * \brief C API: Builder API for Locale
 */

/**
 * Opaque C service object type for the locale builder API
 * @stable ICU 74
 */
struct ULocaleBuilder;

/**
 * C typedef for struct ULocaleBuilder.
 * @stable ICU 74
 */
typedef struct ULocaleBuilder ULocaleBuilder;

/**
 * <code>ULocaleBuilder</code> is used to build valid <code>locale</code> id
 * string or IETF BCP 47 language tag from values configured by the setters.
 * The <code>ULocaleBuilder</code> checks if a value configured by a
 * setter satisfies the syntax requirements defined by the <code>Locale</code>
 * class.  A string of Locale created by a <code>ULocaleBuilder</code> is
 * well-formed and can be transformed to a well-formed IETF BCP 47 language tag
 * without losing information.
 *
 * <p>The following example shows how to create a <code>locale</code> string
 * with the <code>ULocaleBuilder</code>.
 * <blockquote>
 * <pre>
 *     UErrorCode err = U_ZERO_ERROR;
 *     char buffer[ULOC_FULLNAME_CAPACITY];
 *     ULocaleBuilder* builder = ulocbld_open();
 *     ulocbld_setLanguage(builder, "sr", -1);
 *     ulocbld_setScript(builder, "Latn", -1);
 *     ulocbld_setRegion(builder, "RS", -1);
 *     int32_t length = ulocbld_buildLocaleID(
 *         builder, buffer, ULOC_FULLNAME_CAPACITY, &error);
 *     ulocbld_close(builder);
 * </pre>
 * </blockquote>
 *
 * <p>ULocaleBuilders can be reused; <code>ulocbld_clear()</code> resets all
 * fields to their default values.
 *
 * <p>ULocaleBuilder tracks errors in an internal UErrorCode. For all setters,
 * except ulocbld_setLanguageTag and ulocbld_setLocale, ULocaleBuilder will return immediately
 * if the internal UErrorCode is in error state.
 * To reset internal state and error code, call clear method.
 * The ulocbld_setLanguageTag and setLocale method will first clear the internal
 * UErrorCode, then track the error of the validation of the input parameter
 * into the internal UErrorCode.
 *
 * @stable ICU 74
 */

/**
 * Constructs an empty ULocaleBuilder. The default value of all
 * fields, extensions, and private use information is the
 * empty string. The created builder should be destroyed by calling
 * ulocbld_close();
 *
 * @stable ICU 74
 */
U_CAPI ULocaleBuilder* U_EXPORT2
ulocbld_open(void);

/**
 * Close the builder and destroy it's internal states.
 * @param builder the builder
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_close(ULocaleBuilder* builder);

/**
 * Resets the <code>ULocaleBuilder</code> to match the provided
 * <code>locale</code>.  Existing state is discarded.
 *
 * <p>All fields of the locale must be well-formed.
 * <p>This method clears the internal UErrorCode.
 *
 * @param builder the builder
 * @param locale the locale, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the locale; if negative, then the locale need to be
 *               null terminated,
 *
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setLocale(ULocaleBuilder* builder, const char* locale, int32_t length);

/**
 * Resets the <code>ULocaleBuilder</code> to match the provided
 * <code>ULocale</code>. Existing state is discarded.
 *
 * <p>The locale must be not bogus.
 * <p>This method clears the internal UErrorCode.
 *
 * @param builder the builder.
 * @param locale the locale, a ULocale* pointer. The builder adopts the locale
 *               after the call and the client must not delete it.
 *
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_adoptULocale(ULocaleBuilder* builder, ULocale* locale);

/**
 * Resets the ULocaleBuilder to match the provided IETF BCP 47 language tag.
 * Discards the existing state.
 * The empty string causes the builder to be reset, like {@link #ulocbld_clear}.
 * Legacy language tags (marked as “Type: grandfathered” in BCP 47)
 * are converted to their canonical form before being processed.
 * Otherwise, the <code>language tag</code> must be well-formed,
 * or else the ulocbld_buildLocaleID() and ulocbld_buildLanguageTag() methods
 * will later report an U_ILLEGAL_ARGUMENT_ERROR.
 *
 * <p>This method clears the internal UErrorCode.
 *
 * @param builder the builder
 * @param tag the language tag, defined as IETF BCP 47 language tag, a
 *               const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the tag; if negative, then the tag need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setLanguageTag(ULocaleBuilder* builder, const char* tag, int32_t length);

/**
 * Sets the language.  If <code>language</code> is the empty string, the
 * language in this <code>ULocaleBuilder</code> is removed. Otherwise, the
 * <code>language</code> must be well-formed, or else the ulocbld_buildLocaleID()
 * and ulocbld_buildLanguageTag() methods will
 * later report an U_ILLEGAL_ARGUMENT_ERROR.
 *
 * <p>The syntax of language value is defined as
 * [unicode_language_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_language_subtag).
 *
 * @param builder the builder
 * @param language the language, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the language; if negative, then the language need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setLanguage(ULocaleBuilder* builder, const char* language, int32_t length);

/**
 * Sets the script. If <code>script</code> is the empty string, the script in
 * this <code>ULocaleBuilder</code> is removed.
 * Otherwise, the <code>script</code> must be well-formed, or else the
 * ulocbld_buildLocaleID() and ulocbld_buildLanguageTag() methods will later
 * report an U_ILLEGAL_ARGUMENT_ERROR.
 *
 * <p>The script value is a four-letter script code as
 * [unicode_script_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_script_subtag)
 * defined by ISO 15924
 *
 * @param builder the builder
 * @param script the script, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the script; if negative, then the script need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setScript(ULocaleBuilder* builder, const char* script, int32_t length);

/**
 * Sets the region.  If region is the empty string, the region in this
 * <code>ULocaleBuilder</code> is removed. Otherwise, the <code>region</code>
 * must be well-formed, or else the ulocbld_buildLocaleID() and
 * ulocbld_buildLanguageTag() methods will later report an
 * U_ILLEGAL_ARGUMENT_ERROR.
 *
 * <p>The region value is defined by
 *  [unicode_region_subtag](http://www.unicode.org/reports/tr35/tr35.html#unicode_region_subtag)
 * as a two-letter ISO 3166 code or a three-digit UN M.49 area code.
 *
 * <p>The region value in the <code>Locale</code> created by the
 * <code>ULocaleBuilder</code> is always normalized to upper case.
 *
 * @param builder the builder
 * @param region the region, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the region; if negative, then the region need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setRegion(ULocaleBuilder* builder, const char* region, int32_t length);

/**
 * Sets the variant.  If variant is the empty string, the variant in this
 * <code>ULocaleBuilder</code> is removed.  Otherwise, the <code>variant</code>
 * must be well-formed, or else the ulocbld_buildLocaleID() and
 * ulocbld_buildLanguageTag() methods will later report an
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
 * @param builder the builder
 * @param variant the variant, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the variant; if negative, then the variant need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setVariant(ULocaleBuilder* builder, const char* variant, int32_t length);

/**
 * Sets the extension for the given key. If the value is the empty string,
 * the extension is removed.  Otherwise, the <code>key</code> and
 * <code>value</code> must be well-formed, or else the ulocbld_buildLocaleID()
 * and ulocbld_buildLanguageTag() methods will
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
 * @param builder the builder
 * @param key the extension key
 * @param value the value, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the value; if negative, then the value need to be
 *               null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setExtension(ULocaleBuilder* builder, char key, const char* value, int32_t length);

/**
 * Sets the Unicode locale keyword type for the given key. If the type
 * StringPiece is constructed with a nullptr, the keyword is removed.
 * If the type is the empty string, the keyword is set without type subtags.
 * Otherwise, the key and type must be well-formed, or else the
 * ulocbld_buildLocaleID() and ulocbld_buildLanguageTag() methods will later
 * report an U_ILLEGAL_ARGUMENT_ERROR.
 *
 * <p>Keys and types are converted to lower case.
 *
 * <p><b>Note</b>:Setting the 'u' extension via {@link #ulocbld_setExtension}
 * replaces all Unicode locale keywords with those defined in the
 * extension.
 *
 * @param builder the builder
 * @param key the Unicode locale key, a const char * pointer (need not be
 *               terminated when the length is non-negative)
 * @param keyLength the length of the key; if negative, then the key need to be
 *               null terminated,
 * @param type the Unicode locale type, a const char * pointer (need not be
 *               terminated when the length is non-negative)
 * @param typeLength the length of the type; if negative, then the type need to
 *               be null terminated,
 * @return This builder.
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_setUnicodeLocaleKeyword(ULocaleBuilder* builder,
        const char* key, int32_t keyLength, const char* type, int32_t typeLength);

/**
 * Adds a unicode locale attribute, if not already present, otherwise
 * has no effect.  The attribute must not be empty string and must be
 * well-formed or U_ILLEGAL_ARGUMENT_ERROR will be set to status
 * during the ulocbld_buildLocaleID() and ulocbld_buildLanguageTag() calls.
 *
 * @param builder the builder
 * @param attribute the attribute, a const char * pointer (need not be
 *               terminated when the length is non-negative)
 * @param length the length of the attribute; if negative, then the attribute
 *               need to be null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_addUnicodeLocaleAttribute(
    ULocaleBuilder* builder, const char* attribute, int32_t length);

/**
 * Removes a unicode locale attribute, if present, otherwise has no
 * effect.  The attribute must not be empty string and must be well-formed
 * or U_ILLEGAL_ARGUMENT_ERROR will be set to status during the ulocbld_buildLocaleID()
 * and ulocbld_buildLanguageTag() calls.
 *
 * <p>Attribute comparison for removal is case-insensitive.
 *
 * @param builder the builder
 * @param attribute the attribute, a const char * pointer (need not be
 *               terminated when the length is non-negative)
 * @param length the length of the attribute; if negative, then the attribute
 *               need to be null terminated,
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_removeUnicodeLocaleAttribute(
    ULocaleBuilder* builder, const char* attribute, int32_t length);

/**
 * Resets the builder to its initial, empty state.
 * <p>This method clears the internal UErrorCode.
 *
 * @param builder the builder
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_clear(ULocaleBuilder* builder);

/**
 * Resets the extensions to their initial, empty state.
 * Language, script, region and variant are unchanged.
 *
 * @param builder the builder
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocbld_clearExtensions(ULocaleBuilder* builder);

/**
 * Build the LocaleID string from the fields set on this builder.
 * If any set methods or during the ulocbld_buildLocaleID() call require memory
 * allocation but fail U_MEMORY_ALLOCATION_ERROR will be set to status.
 * If any of the fields set by the setters are not well-formed, the status
 * will be set to U_ILLEGAL_ARGUMENT_ERROR. The state of the builder will
 * not change after the ulocbld_buildLocaleID() call and the caller is
 * free to keep using the same builder to build more locales.
 *
 * @param builder the builder
 * @param locale the locale id
 * @param localeCapacity the size of the locale buffer to store the locale id
 * @param err the error code
 * @return the length of the locale id in buffer
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2
ulocbld_buildLocaleID(ULocaleBuilder* builder, char* locale,
                      int32_t localeCapacity, UErrorCode* err);

/**
 * Build the ULocale object from the fields set on this builder.
 * If any set methods or during the ulocbld_buildULocale() call require memory
 * allocation but fail U_MEMORY_ALLOCATION_ERROR will be set to status.
 * If any of the fields set by the setters are not well-formed, the status
 * will be set to U_ILLEGAL_ARGUMENT_ERROR. The state of the builder will
 * not change after the ulocbld_buildULocale() call and the caller is
 * free to keep using the same builder to build more locales.
 *
 * @param builder the builder.
 * @param err the error code.
 * @return the locale, a ULocale* pointer. The created ULocale must be
 *          destroyed by calling {@link ulocale_close}.
 * @stable ICU 74
 */
U_CAPI ULocale* U_EXPORT2
ulocbld_buildULocale(ULocaleBuilder* builder, UErrorCode* err);

/**
 * Build the IETF BCP 47 language tag string from the fields set on this builder.
 * If any set methods or during the ulocbld_buildLanguageTag() call require memory
 * allocation but fail U_MEMORY_ALLOCATION_ERROR will be set to status.
 * If any of the fields set by the setters are not well-formed, the status
 * will be set to U_ILLEGAL_ARGUMENT_ERROR. The state of the builder will
 * not change after the ulocbld_buildLanguageTag() call and the caller is free
 * to keep using the same builder to build more locales.
 *
 * @param builder the builder
 * @param language the language tag
 * @param languageCapacity the size of the language buffer to store the language
 * tag
 * @param err the error code
 * @return the length of the language tag in buffer
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2
ulocbld_buildLanguageTag(ULocaleBuilder* builder, char* language,
                      int32_t languageCapacity, UErrorCode* err);

/**
 * Sets the UErrorCode if an error occurred while recording sets.
 * Preserves older error codes in the outErrorCode.
 *
 * @param builder the builder
 * @param outErrorCode Set to an error code that occurred while setting subtags.
 *                  Unchanged if there is no such error or if outErrorCode
 *                  already contained an error.
 * @return true if U_FAILURE(*outErrorCode)
 * @stable ICU 74
 */
U_CAPI UBool U_EXPORT2
ulocbld_copyErrorTo(const ULocaleBuilder* builder, UErrorCode *outErrorCode);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalULocaleBuilderPointer
 * "Smart pointer" class, closes a ULocaleBuilder via ulocbld_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 74
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalULocaleBuilderPointer, ULocaleBuilder, ulocbld_close);

U_NAMESPACE_END

#endif  /* U_SHOW_CPLUSPLUS_API */

#endif  // __ULOCBUILDER_H__
