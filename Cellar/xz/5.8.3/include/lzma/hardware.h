/* SPDX-License-Identifier: 0BSD */

/**
 * \file        lzma/hardware.h
 * \brief       Hardware information
 * \note        Never include this file directly. Use <lzma.h> instead.
 *
 * Since liblzma can consume a lot of system resources, it also provides
 * ways to limit the resource usage. Applications linking against liblzma
 * need to do the actual decisions how much resources to let liblzma to use.
 * To ease making these decisions, liblzma provides functions to find out
 * the relevant capabilities of the underlying hardware. Currently there
 * is only a function to find out the amount of RAM, but in the future there
 * will be also a function to detect how many concurrent threads the system
 * can run.
 *
 * \note        On some operating systems, these function may temporarily
 *              load a shared library or open file descriptor(s) to find out
 *              the requested hardware information. Unless the application
 *              assumes that specific file descriptors are not touched by
 *              other threads, this should have no effect on thread safety.
 *              Possible operations involving file descriptors will restart
 *              the syscalls if they return EINTR.
 */

/*
 * Author: Lasse Collin
 */

#ifndef LZMA_H_INTERNAL
#	error Never include this file directly. Use <lzma.h> instead.
#endif


/**
 * \brief       Get the total amount of physical memory (RAM) in bytes
 *
 * This function may be useful when determining a reasonable memory
 * usage limit for decompressing or how much memory it is OK to use
 * for compressing.
 *
 * \return      On success, the total amount of physical memory in bytes
 *              is returned. If the amount of RAM cannot be determined,
 *              zero is returned. This can happen if an error occurs
 *              or if there is no code in liblzma to detect the amount
 *              of RAM on the specific operating system.
 */
extern LZMA_API(uint64_t) lzma_physmem(void) lzma_nothrow;


/**
 * \brief       Get the number of processor cores or threads
 *
 * This function may be useful when determining how many threads to use.
 * If the hardware supports more than one thread per CPU core, the number
 * of hardware threads is returned if that information is available.
 *
 * \return      On success, the number of available CPU threads or cores is
 *              returned. If this information isn't available or an error
 *              occurs, zero is returned.
 */
extern LZMA_API(uint32_t) lzma_cputhreads(void) lzma_nothrow;
