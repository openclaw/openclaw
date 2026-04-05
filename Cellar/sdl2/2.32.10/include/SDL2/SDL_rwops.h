/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

/* WIKI CATEGORY: RWOPS */

/**
 * # CategoryRWOPS
 *
 * This file provides a general interface for SDL to read and write data
 * streams. It can easily be extended to files, memory, etc.
 */

#ifndef SDL_rwops_h_
#define SDL_rwops_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* RWops Types */
#define SDL_RWOPS_UNKNOWN   0U  /**< Unknown stream type */
#define SDL_RWOPS_WINFILE   1U  /**< Win32 file */
#define SDL_RWOPS_STDFILE   2U  /**< Stdio file */
#define SDL_RWOPS_JNIFILE   3U  /**< Android asset */
#define SDL_RWOPS_MEMORY    4U  /**< Memory stream */
#define SDL_RWOPS_MEMORY_RO 5U  /**< Read-Only memory stream */

/**
 * This is the read/write operation structure -- very basic.
 */
typedef struct SDL_RWops
{
    /**
     *  Return the size of the file in this rwops, or -1 if unknown
     */
    Sint64 (SDLCALL * size) (struct SDL_RWops * context);

    /**
     *  Seek to `offset` relative to `whence`, one of stdio's whence values:
     *  RW_SEEK_SET, RW_SEEK_CUR, RW_SEEK_END
     *
     *  \return the final offset in the data stream, or -1 on error.
     */
    Sint64 (SDLCALL * seek) (struct SDL_RWops * context, Sint64 offset,
                             int whence);

    /**
     *  Read up to `maxnum` objects each of size `size` from the data
     *  stream to the area pointed at by `ptr`.
     *
     *  \return the number of objects read, or 0 at error or end of file.
     */
    size_t (SDLCALL * read) (struct SDL_RWops * context, void *ptr,
                             size_t size, size_t maxnum);

    /**
     *  Write exactly `num` objects each of size `size` from the area
     *  pointed at by `ptr` to data stream.
     *
     *  \return the number of objects written, or 0 at error or end of file.
     */
    size_t (SDLCALL * write) (struct SDL_RWops * context, const void *ptr,
                              size_t size, size_t num);

    /**
     *  Close and free an allocated SDL_RWops structure.
     *
     *  \return 0 if successful or -1 on write error when flushing data.
     */
    int (SDLCALL * close) (struct SDL_RWops * context);

    Uint32 type;
    union
    {
#if defined(__ANDROID__)
        struct
        {
            void *asset;
        } androidio;
#elif defined(__WIN32__) || defined(__GDK__)
        struct
        {
            SDL_bool append;
            void *h;
            struct
            {
                void *data;
                size_t size;
                size_t left;
            } buffer;
        } windowsio;
#endif

#ifdef HAVE_STDIO_H
        struct
        {
            SDL_bool autoclose;
            FILE *fp;
        } stdio;
#endif
        struct
        {
            Uint8 *base;
            Uint8 *here;
            Uint8 *stop;
        } mem;
        struct
        {
            void *data1;
            void *data2;
        } unknown;
    } hidden;

} SDL_RWops;


/**
 *  \name RWFrom functions
 *
 *  Functions to create SDL_RWops structures from various data streams.
 */
/* @{ */

/**
 * Use this function to create a new SDL_RWops structure for reading from
 * and/or writing to a named file.
 *
 * The `mode` string is treated roughly the same as in a call to the C
 * library's fopen(), even if SDL doesn't happen to use fopen() behind the
 * scenes.
 *
 * Available `mode` strings:
 *
 * - "r": Open a file for reading. The file must exist.
 * - "w": Create an empty file for writing. If a file with the same name
 *   already exists its content is erased and the file is treated as a new
 *   empty file.
 * - "a": Append to a file. Writing operations append data at the end of the
 *   file. The file is created if it does not exist.
 * - "r+": Open a file for update both reading and writing. The file must
 *   exist.
 * - "w+": Create an empty file for both reading and writing. If a file with
 *   the same name already exists its content is erased and the file is
 *   treated as a new empty file.
 * - "a+": Open a file for reading and appending. All writing operations are
 *   performed at the end of the file, protecting the previous content to be
 *   overwritten. You can reposition (fseek, rewind) the internal pointer to
 *   anywhere in the file for reading, but writing operations will move it
 *   back to the end of file. The file is created if it does not exist.
 *
 * **NOTE**: In order to open a file as a binary file, a "b" character has to
 * be included in the `mode` string. This additional "b" character can either
 * be appended at the end of the string (thus making the following compound
 * modes: "rb", "wb", "ab", "r+b", "w+b", "a+b") or be inserted between the
 * letter and the "+" sign for the mixed modes ("rb+", "wb+", "ab+").
 * Additional characters may follow the sequence, although they should have no
 * effect. For example, "t" is sometimes appended to make explicit the file is
 * a text file.
 *
 * This function supports Unicode filenames, but they must be encoded in UTF-8
 * format, regardless of the underlying operating system.
 *
 * As a fallback, SDL_RWFromFile() will transparently open a matching filename
 * in an Android app's `assets`.
 *
 * Closing the SDL_RWops will close the file handle SDL is holding internally.
 *
 * \param file a UTF-8 string representing the filename to open.
 * \param mode an ASCII string representing the mode to be used for opening
 *             the file.
 * \returns a pointer to the SDL_RWops structure that is created, or NULL on
 *          failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWtell
 * \sa SDL_RWwrite
 */
extern DECLSPEC SDL_RWops *SDLCALL SDL_RWFromFile(const char *file,
                                                  const char *mode);

#ifdef HAVE_STDIO_H

extern DECLSPEC SDL_RWops *SDLCALL SDL_RWFromFP(FILE * fp, SDL_bool autoclose);

#else

/**
 * Use this function to create an SDL_RWops structure from a standard I/O file
 * pointer (stdio.h's `FILE*`).
 *
 * This function is not available on Windows, since files opened in an
 * application on that platform cannot be used by a dynamically linked
 * library.
 *
 * On some platforms, the first parameter is a `void*`, on others, it's a
 * `FILE*`, depending on what system headers are available to SDL. It is
 * always intended to be the `FILE*` type from the C runtime's stdio.h.
 *
 * \param fp the `FILE*` that feeds the SDL_RWops stream.
 * \param autoclose SDL_TRUE to close the `FILE*` when closing the SDL_RWops,
 *                  SDL_FALSE to leave the `FILE*` open when the RWops is
 *                  closed.
 * \returns a pointer to the SDL_RWops structure that is created, or NULL on
 *          failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWtell
 * \sa SDL_RWwrite
 */
extern DECLSPEC SDL_RWops *SDLCALL SDL_RWFromFP(void * fp,
                                                SDL_bool autoclose);
#endif

/**
 * Use this function to prepare a read-write memory buffer for use with
 * SDL_RWops.
 *
 * This function sets up an SDL_RWops struct based on a memory area of a
 * certain size, for both read and write access.
 *
 * This memory buffer is not copied by the RWops; the pointer you provide must
 * remain valid until you close the stream. Closing the stream will not free
 * the original buffer.
 *
 * If you need to make sure the RWops never writes to the memory buffer, you
 * should use SDL_RWFromConstMem() with a read-only buffer of memory instead.
 *
 * \param mem a pointer to a buffer to feed an SDL_RWops stream.
 * \param size the buffer size, in bytes.
 * \returns a pointer to a new SDL_RWops structure, or NULL if it fails; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWtell
 * \sa SDL_RWwrite
 */
extern DECLSPEC SDL_RWops *SDLCALL SDL_RWFromMem(void *mem, int size);

/**
 * Use this function to prepare a read-only memory buffer for use with RWops.
 *
 * This function sets up an SDL_RWops struct based on a memory area of a
 * certain size. It assumes the memory area is not writable.
 *
 * Attempting to write to this RWops stream will report an error without
 * writing to the memory buffer.
 *
 * This memory buffer is not copied by the RWops; the pointer you provide must
 * remain valid until you close the stream. Closing the stream will not free
 * the original buffer.
 *
 * If you need to write to a memory buffer, you should use SDL_RWFromMem()
 * with a writable buffer of memory instead.
 *
 * \param mem a pointer to a read-only buffer to feed an SDL_RWops stream.
 * \param size the buffer size, in bytes.
 * \returns a pointer to a new SDL_RWops structure, or NULL if it fails; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWtell
 */
extern DECLSPEC SDL_RWops *SDLCALL SDL_RWFromConstMem(const void *mem,
                                                      int size);

/* @} *//* RWFrom functions */


/**
 * Use this function to allocate an empty, unpopulated SDL_RWops structure.
 *
 * Applications do not need to use this function unless they are providing
 * their own SDL_RWops implementation. If you just need a SDL_RWops to
 * read/write a common data source, you should use the built-in
 * implementations in SDL, like SDL_RWFromFile() or SDL_RWFromMem(), etc.
 *
 * You must free the returned pointer with SDL_FreeRW(). Depending on your
 * operating system and compiler, there may be a difference between the
 * malloc() and free() your program uses and the versions SDL calls
 * internally. Trying to mix the two can cause crashing such as segmentation
 * faults. Since all SDL_RWops must free themselves when their **close**
 * method is called, all SDL_RWops must be allocated through this function, so
 * they can all be freed correctly with SDL_FreeRW().
 *
 * \returns a pointer to the allocated memory on success, or NULL on failure;
 *          call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_FreeRW
 */
extern DECLSPEC SDL_RWops *SDLCALL SDL_AllocRW(void);

/**
 * Use this function to free an SDL_RWops structure allocated by
 * SDL_AllocRW().
 *
 * Applications do not need to use this function unless they are providing
 * their own SDL_RWops implementation. If you just need a SDL_RWops to
 * read/write a common data source, you should use the built-in
 * implementations in SDL, like SDL_RWFromFile() or SDL_RWFromMem(), etc, and
 * call the **close** method on those SDL_RWops pointers when you are done
 * with them.
 *
 * Only use SDL_FreeRW() on pointers returned by SDL_AllocRW(). The pointer is
 * invalid as soon as this function returns. Any extra memory allocated during
 * creation of the SDL_RWops is not freed by SDL_FreeRW(); the programmer must
 * be responsible for managing that memory in their **close** method.
 *
 * \param area the SDL_RWops structure to be freed.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AllocRW
 */
extern DECLSPEC void SDLCALL SDL_FreeRW(SDL_RWops * area);

/* Possible `whence` values for SDL_RWops seeking... */
#define RW_SEEK_SET 0       /**< Seek from the beginning of data */
#define RW_SEEK_CUR 1       /**< Seek relative to current read point */
#define RW_SEEK_END 2       /**< Seek relative to the end of data */

/**
 * Use this function to get the size of the data stream in an SDL_RWops.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context the SDL_RWops to get the size of the data stream from.
 * \returns the size of the data stream in the SDL_RWops on success, -1 if
 *          unknown or a negative error code on failure; call SDL_GetError()
 *          for more information.
 *
 * \since This function is available since SDL 2.0.10.
 */
extern DECLSPEC Sint64 SDLCALL SDL_RWsize(SDL_RWops *context);

/**
 * Seek within an SDL_RWops data stream.
 *
 * This function seeks to byte `offset`, relative to `whence`.
 *
 * `whence` may be any of the following values:
 *
 * - `RW_SEEK_SET`: seek from the beginning of data
 * - `RW_SEEK_CUR`: seek relative to current read point
 * - `RW_SEEK_END`: seek relative to the end of data
 *
 * If this stream can not seek, it will return -1.
 *
 * SDL_RWseek() is actually a wrapper function that calls the SDL_RWops's
 * `seek` method appropriately, to simplify application development.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context a pointer to an SDL_RWops structure.
 * \param offset an offset in bytes, relative to **whence** location; can be
 *               negative.
 * \param whence any of `RW_SEEK_SET`, `RW_SEEK_CUR`, `RW_SEEK_END`.
 * \returns the final offset in the data stream after the seek or -1 on error.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWtell
 * \sa SDL_RWwrite
 */
extern DECLSPEC Sint64 SDLCALL SDL_RWseek(SDL_RWops *context,
                                          Sint64 offset, int whence);

/**
 * Determine the current read/write offset in an SDL_RWops data stream.
 *
 * SDL_RWtell is actually a wrapper function that calls the SDL_RWops's `seek`
 * method, with an offset of 0 bytes from `RW_SEEK_CUR`, to simplify
 * application development.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context a SDL_RWops data stream object from which to get the current
 *                offset.
 * \returns the current offset in the stream, or -1 if the information can not
 *          be determined.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWwrite
 */
extern DECLSPEC Sint64 SDLCALL SDL_RWtell(SDL_RWops *context);

/**
 * Read from a data source.
 *
 * This function reads up to `maxnum` objects each of size `size` from the
 * data source to the area pointed at by `ptr`. This function may read less
 * objects than requested. It will return zero when there has been an error or
 * the data stream is completely read.
 *
 * SDL_RWread() is actually a function wrapper that calls the SDL_RWops's
 * `read` method appropriately, to simplify application development.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context a pointer to an SDL_RWops structure.
 * \param ptr a pointer to a buffer to read data into.
 * \param size the size of each object to read, in bytes.
 * \param maxnum the maximum number of objects to be read.
 * \returns the number of objects read, or 0 at error or end of file; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWseek
 * \sa SDL_RWwrite
 */
extern DECLSPEC size_t SDLCALL SDL_RWread(SDL_RWops *context,
                                          void *ptr, size_t size,
                                          size_t maxnum);

/**
 * Write to an SDL_RWops data stream.
 *
 * This function writes exactly `num` objects each of size `size` from the
 * area pointed at by `ptr` to the stream. If this fails for any reason, it'll
 * return less than `num` to demonstrate how far the write progressed. On
 * success, it returns `num`.
 *
 * SDL_RWwrite is actually a function wrapper that calls the SDL_RWops's
 * `write` method appropriately, to simplify application development.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context a pointer to an SDL_RWops structure.
 * \param ptr a pointer to a buffer containing data to write.
 * \param size the size of an object to write, in bytes.
 * \param num the number of objects to write.
 * \returns the number of objects written, which will be less than **num** on
 *          error; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_RWclose
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 */
extern DECLSPEC size_t SDLCALL SDL_RWwrite(SDL_RWops *context,
                                           const void *ptr, size_t size,
                                           size_t num);

/**
 * Close and free an allocated SDL_RWops structure.
 *
 * SDL_RWclose() closes and cleans up the SDL_RWops stream. It releases any
 * resources used by the stream and frees the SDL_RWops itself with
 * SDL_FreeRW(). This returns 0 on success, or -1 if the stream failed to
 * flush to its output (e.g. to disk).
 *
 * Note that if this fails to flush the stream to disk, this function reports
 * an error, but the SDL_RWops is still invalid once this function returns.
 *
 * Prior to SDL 2.0.10, this function was a macro.
 *
 * \param context SDL_RWops structure to close.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.10.
 *
 * \sa SDL_RWFromConstMem
 * \sa SDL_RWFromFile
 * \sa SDL_RWFromFP
 * \sa SDL_RWFromMem
 * \sa SDL_RWread
 * \sa SDL_RWseek
 * \sa SDL_RWwrite
 */
extern DECLSPEC int SDLCALL SDL_RWclose(SDL_RWops *context);

/**
 * Load all the data from an SDL data stream.
 *
 * The data is allocated with a zero byte at the end (null terminated) for
 * convenience. This extra byte is not included in the value reported via
 * `datasize`.
 *
 * The data should be freed with SDL_free().
 *
 * \param src the SDL_RWops to read all available data from.
 * \param datasize if not NULL, will store the number of bytes read.
 * \param freesrc if non-zero, calls SDL_RWclose() on `src` before returning.
 * \returns the data, or NULL if there was an error.
 *
 * \since This function is available since SDL 2.0.6.
 */
extern DECLSPEC void *SDLCALL SDL_LoadFile_RW(SDL_RWops *src,
                                              size_t *datasize,
                                              int freesrc);

/**
 * Load all the data from a file path.
 *
 * The data is allocated with a zero byte at the end (null terminated) for
 * convenience. This extra byte is not included in the value reported via
 * `datasize`.
 *
 * The data should be freed with SDL_free().
 *
 * Prior to SDL 2.0.10, this function was a macro wrapping around
 * SDL_LoadFile_RW.
 *
 * \param file the path to read all available data from.
 * \param datasize if not NULL, will store the number of bytes read.
 * \returns the data, or NULL if there was an error.
 *
 * \since This function is available since SDL 2.0.10.
 */
extern DECLSPEC void *SDLCALL SDL_LoadFile(const char *file, size_t *datasize);

/**
 *  \name Read endian functions
 *
 *  Read an item of the specified endianness and return in native format.
 */
/* @{ */

/**
 * Use this function to read a byte from an SDL_RWops.
 *
 * \param src the SDL_RWops to read from.
 * \returns the read byte on success or 0 on failure; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteU8
 */
extern DECLSPEC Uint8 SDLCALL SDL_ReadU8(SDL_RWops * src);

/**
 * Use this function to read 16 bits of little-endian data from an SDL_RWops
 * and return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 16 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadBE16
 */
extern DECLSPEC Uint16 SDLCALL SDL_ReadLE16(SDL_RWops * src);

/**
 * Use this function to read 16 bits of big-endian data from an SDL_RWops and
 * return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 16 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadLE16
 */
extern DECLSPEC Uint16 SDLCALL SDL_ReadBE16(SDL_RWops * src);

/**
 * Use this function to read 32 bits of little-endian data from an SDL_RWops
 * and return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 32 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadBE32
 */
extern DECLSPEC Uint32 SDLCALL SDL_ReadLE32(SDL_RWops * src);

/**
 * Use this function to read 32 bits of big-endian data from an SDL_RWops and
 * return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 32 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadLE32
 */
extern DECLSPEC Uint32 SDLCALL SDL_ReadBE32(SDL_RWops * src);

/**
 * Use this function to read 64 bits of little-endian data from an SDL_RWops
 * and return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 64 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadBE64
 */
extern DECLSPEC Uint64 SDLCALL SDL_ReadLE64(SDL_RWops * src);

/**
 * Use this function to read 64 bits of big-endian data from an SDL_RWops and
 * return in native format.
 *
 * SDL byteswaps the data only if necessary, so the data returned will be in
 * the native byte order.
 *
 * \param src the stream from which to read data.
 * \returns 64 bits of data in the native byte order of the platform.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadLE64
 */
extern DECLSPEC Uint64 SDLCALL SDL_ReadBE64(SDL_RWops * src);
/* @} *//* Read endian functions */

/**
 *  \name Write endian functions
 *
 *  Write an item of native format to the specified endianness.
 */
/* @{ */

/**
 * Use this function to write a byte to an SDL_RWops.
 *
 * \param dst the SDL_RWops to write to.
 * \param value the byte value to write.
 * \returns 1 on success or 0 on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_ReadU8
 */
extern DECLSPEC size_t SDLCALL SDL_WriteU8(SDL_RWops * dst, Uint8 value);

/**
 * Use this function to write 16 bits in native format to a SDL_RWops as
 * little-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in little-endian
 * format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteBE16
 */
extern DECLSPEC size_t SDLCALL SDL_WriteLE16(SDL_RWops * dst, Uint16 value);

/**
 * Use this function to write 16 bits in native format to a SDL_RWops as
 * big-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in big-endian format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteLE16
 */
extern DECLSPEC size_t SDLCALL SDL_WriteBE16(SDL_RWops * dst, Uint16 value);

/**
 * Use this function to write 32 bits in native format to a SDL_RWops as
 * little-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in little-endian
 * format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteBE32
 */
extern DECLSPEC size_t SDLCALL SDL_WriteLE32(SDL_RWops * dst, Uint32 value);

/**
 * Use this function to write 32 bits in native format to a SDL_RWops as
 * big-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in big-endian format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteLE32
 */
extern DECLSPEC size_t SDLCALL SDL_WriteBE32(SDL_RWops * dst, Uint32 value);

/**
 * Use this function to write 64 bits in native format to a SDL_RWops as
 * little-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in little-endian
 * format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteBE64
 */
extern DECLSPEC size_t SDLCALL SDL_WriteLE64(SDL_RWops * dst, Uint64 value);

/**
 * Use this function to write 64 bits in native format to a SDL_RWops as
 * big-endian data.
 *
 * SDL byteswaps the data only if necessary, so the application always
 * specifies native format, and the data written will be in big-endian format.
 *
 * \param dst the stream to which data will be written.
 * \param value the data to be written, in native format.
 * \returns 1 on successful write, 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_WriteLE64
 */
extern DECLSPEC size_t SDLCALL SDL_WriteBE64(SDL_RWops * dst, Uint64 value);
/* @} *//* Write endian functions */

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_rwops_h_ */

/* vi: set ts=4 sw=4 expandtab: */
