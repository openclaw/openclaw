
liblzma example programs
========================

Introduction

    The examples are written so that the same comments aren't
    repeated (much) in later files.

    On POSIX systems, the examples should build by just typing "make".

    The examples that use stdin or stdout don't set stdin and stdout
    to binary mode. On systems where it matters (e.g. Windows) it is
    possible that the examples won't work without modification.


List of examples

    01_compress_easy.c                  Multi-call compression using
                                        a compression preset

    02_decompress.c                     Multi-call decompression

    03_compress_custom.c                Like 01_compress_easy.c but using
                                        a custom filter chain
                                        (x86 BCJ + LZMA2)

    04_compress_easy_mt.c               Multi-threaded multi-call
                                        compression using a compression
                                        preset

