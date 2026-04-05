/*
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/**
 * @file
 * Public dictionary API.
 * @deprecated
 *  AVDictionary is provided for compatibility with libav. It is both in
 *  implementation as well as API inefficient. It does not scale and is
 *  extremely slow with large dictionaries.
 *  It is recommended that new code uses our tree container from tree.c/h
 *  where applicable, which uses AVL trees to achieve O(log n) performance.
 */

#ifndef AVUTIL_DICT_H
#define AVUTIL_DICT_H

#include <stdint.h>

/**
 * @addtogroup lavu_dict AVDictionary
 * @ingroup lavu_data
 *
 * @brief Simple key:value store
 *
 * @{
 * Dictionaries are used for storing key-value pairs.
 *
 * - To **create an AVDictionary**, simply pass an address of a NULL
 *   pointer to av_dict_set(). NULL can be used as an empty dictionary
 *   wherever a pointer to an AVDictionary is required.
 * - To **insert an entry**, use av_dict_set().
 * - Use av_dict_get() to **retrieve an entry**.
 * - To **iterate over all entries**, use av_dict_iterate().
 * - In order to **free the dictionary and all its contents**, use av_dict_free().
 *
 @code
   AVDictionary *d = NULL;           // "create" an empty dictionary
   AVDictionaryEntry *t = NULL;

   av_dict_set(&d, "foo", "bar", 0); // add an entry

   char *k = av_strdup("key");       // if your strings are already allocated,
   char *v = av_strdup("value");     // you can avoid copying them like this
   av_dict_set(&d, k, v, AV_DICT_DONT_STRDUP_KEY | AV_DICT_DONT_STRDUP_VAL);

   while ((t = av_dict_iterate(d, t))) {
       <....>                        // iterate over all entries in d
   }
   av_dict_free(&d);
 @endcode
 */

/**
 * @name AVDictionary Flags
 * Flags that influence behavior of the matching of keys or insertion to the dictionary.
 * @{
 */
#define AV_DICT_MATCH_CASE      1   /**< Only get an entry with exact-case key match. Only relevant in av_dict_get(). */
#define AV_DICT_IGNORE_SUFFIX   2   /**< Return first entry in a dictionary whose first part corresponds to the search key,
                                         ignoring the suffix of the found key string. Only relevant in av_dict_get(). */
#define AV_DICT_DONT_STRDUP_KEY 4   /**< Take ownership of a key that's been
                                         allocated with av_malloc() or another memory allocation function. */
#define AV_DICT_DONT_STRDUP_VAL 8   /**< Take ownership of a value that's been
                                         allocated with av_malloc() or another memory allocation function. */
#define AV_DICT_DONT_OVERWRITE 16   /**< Don't overwrite existing entries. */
#define AV_DICT_APPEND         32   /**< If the entry already exists, append to it.  Note that no
                                         delimiter is added, the strings are simply concatenated. */
#define AV_DICT_MULTIKEY       64   /**< Allow to store several equal keys in the dictionary */
#define AV_DICT_DEDUP         128   /**< If inserting a value that already exists for a key, do nothing. Only relevant with AV_DICT_MULTIKEY. */
/**
 * @}
 */

typedef struct AVDictionaryEntry {
    char *key;
    char *value;
} AVDictionaryEntry;

typedef struct AVDictionary AVDictionary;

/**
 * Get a dictionary entry with matching key.
 *
 * The returned entry key or value must not be changed, or it will
 * cause undefined behavior.
 *
 * @param prev  Set to the previous matching element to find the next.
 *              If set to NULL the first matching element is returned.
 * @param key   Matching key
 * @param flags A collection of AV_DICT_* flags controlling how the
 *              entry is retrieved
 *
 * @return      Found entry or NULL in case no matching entry was found in the dictionary
 */
AVDictionaryEntry *av_dict_get(const AVDictionary *m, const char *key,
                               const AVDictionaryEntry *prev, int flags);

/**
 * Iterate over a dictionary
 *
 * Iterates through all entries in the dictionary.
 *
 * @warning The returned AVDictionaryEntry key/value must not be changed.
 *
 * @warning As av_dict_set() invalidates all previous entries returned
 * by this function, it must not be called while iterating over the dict.
 *
 * Typical usage:
 * @code
 * const AVDictionaryEntry *e = NULL;
 * while ((e = av_dict_iterate(m, e))) {
 *     // ...
 * }
 * @endcode
 *
 * @param m     The dictionary to iterate over
 * @param prev  Pointer to the previous AVDictionaryEntry, NULL initially
 *
 * @retval AVDictionaryEntry* The next element in the dictionary
 * @retval NULL               No more elements in the dictionary
 */
const AVDictionaryEntry *av_dict_iterate(const AVDictionary *m,
                                         const AVDictionaryEntry *prev);

/**
 * Get number of entries in dictionary.
 *
 * @param m dictionary
 * @return  number of entries in dictionary
 */
int av_dict_count(const AVDictionary *m);

/**
 * Set the given entry in *pm, overwriting an existing entry.
 *
 * Note: If AV_DICT_DONT_STRDUP_KEY or AV_DICT_DONT_STRDUP_VAL is set,
 * these arguments will be freed on error.
 *
 * @warning Adding a new entry to a dictionary invalidates all existing entries
 * previously returned with av_dict_get() or av_dict_iterate().
 *
 * @param pm        Pointer to a pointer to a dictionary struct. If *pm is NULL
 *                  a dictionary struct is allocated and put in *pm.
 * @param key       Entry key to add to *pm (will either be av_strduped or added as a new key depending on flags)
 * @param value     Entry value to add to *pm (will be av_strduped or added as a new key depending on flags).
 *                  Passing a NULL value will cause an existing entry to be deleted.
 *
 * @return          >= 0 on success otherwise an error code <0
 */
int av_dict_set(AVDictionary **pm, const char *key, const char *value, int flags);

/**
 * Convenience wrapper for av_dict_set() that converts the value to a string
 * and stores it.
 *
 * Note: If ::AV_DICT_DONT_STRDUP_KEY is set, key will be freed on error.
 */
int av_dict_set_int(AVDictionary **pm, const char *key, int64_t value, int flags);

/**
 * Parse the key/value pairs list and add the parsed entries to a dictionary.
 *
 * In case of failure, all the successfully set entries are stored in
 * *pm. You may need to manually free the created dictionary.
 *
 * @param key_val_sep  A 0-terminated list of characters used to separate
 *                     key from value
 * @param pairs_sep    A 0-terminated list of characters used to separate
 *                     two pairs from each other
 * @param flags        Flags to use when adding to the dictionary.
 *                     ::AV_DICT_DONT_STRDUP_KEY and ::AV_DICT_DONT_STRDUP_VAL
 *                     are ignored since the key/value tokens will always
 *                     be duplicated.
 *
 * @return             0 on success, negative AVERROR code on failure
 */
int av_dict_parse_string(AVDictionary **pm, const char *str,
                         const char *key_val_sep, const char *pairs_sep,
                         int flags);

/**
 * Copy entries from one AVDictionary struct into another.
 *
 * @note Metadata is read using the ::AV_DICT_IGNORE_SUFFIX flag
 *
 * @param dst   Pointer to a pointer to a AVDictionary struct to copy into. If *dst is NULL,
 *              this function will allocate a struct for you and put it in *dst
 * @param src   Pointer to the source AVDictionary struct to copy items from.
 * @param flags Flags to use when setting entries in *dst
 *
 * @return 0 on success, negative AVERROR code on failure. If dst was allocated
 *           by this function, callers should free the associated memory.
 */
int av_dict_copy(AVDictionary **dst, const AVDictionary *src, int flags);

/**
 * Free all the memory allocated for an AVDictionary struct
 * and all keys and values.
 */
void av_dict_free(AVDictionary **m);

/**
 * Get dictionary entries as a string.
 *
 * Create a string containing dictionary's entries.
 * Such string may be passed back to av_dict_parse_string().
 * @note String is escaped with backslashes ('\').
 *
 * @warning Separators cannot be neither '\\' nor '\0'. They also cannot be the same.
 *
 * @param[in]  m             The dictionary
 * @param[out] buffer        Pointer to buffer that will be allocated with string containing entries.
 *                           Buffer must be freed by the caller when is no longer needed.
 * @param[in]  key_val_sep   Character used to separate key from value
 * @param[in]  pairs_sep     Character used to separate two pairs from each other
 *
 * @return                   >= 0 on success, negative on error
 */
int av_dict_get_string(const AVDictionary *m, char **buffer,
                       const char key_val_sep, const char pairs_sep);

/**
 * @}
 */

#endif /* AVUTIL_DICT_H */
