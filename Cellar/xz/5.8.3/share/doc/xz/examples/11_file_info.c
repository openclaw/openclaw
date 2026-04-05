// SPDX-License-Identifier: 0BSD

///////////////////////////////////////////////////////////////////////////////
//
/// \file       11_file_info.c
/// \brief      Get uncompressed size of .xz file(s)
///
/// Usage:      ./11_file_info INFILE1.xz [INFILEn.xz]...
///
/// Example:    ./11_file_info foo.xz
//
//  Author:     Lasse Collin
//
///////////////////////////////////////////////////////////////////////////////

#include <stdbool.h>
#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <lzma.h>


static bool
print_file_size(lzma_stream *strm, FILE *infile, const char *filename)
{
	// Get the file size. In standard C it can be done by seeking to
	// the end of the file and then getting the file position.
	// In POSIX one can use fstat() and then st_size from struct stat.
	// Also note that fseek() and ftell() use long and thus don't support
	// large files on 32-bit systems (POSIX versions fseeko() and
	// ftello() can support large files).
	if (fseek(infile, 0, SEEK_END)) {
		fprintf(stderr, "Error seeking the file '%s': %s\n",
				filename, strerror(errno));
		return false;
	}

	const long file_size = ftell(infile);

	// The decoder wants to start from the beginning of the .xz file.
	rewind(infile);

	// Initialize the decoder.
	lzma_index *i;
	lzma_ret ret = lzma_file_info_decoder(strm, &i, UINT64_MAX,
			(uint64_t)file_size);
	switch (ret) {
	case LZMA_OK:
		// Initialization succeeded.
		break;

	case LZMA_MEM_ERROR:
		fprintf(stderr, "Out of memory when initializing "
				"the .xz file info decoder\n");
		return false;

	case LZMA_PROG_ERROR:
	default:
		fprintf(stderr, "Unknown error, possibly a bug\n");
		return false;
	}

	// This example program reuses the same lzma_stream structure
	// for multiple files, so we need to reset this when starting
	// a new file.
	strm->avail_in = 0;

	// Buffer for input data.
	uint8_t inbuf[BUFSIZ];

	// Pass data to the decoder and seek when needed.
	while (true) {
		if (strm->avail_in == 0) {
			strm->next_in = inbuf;
			strm->avail_in = fread(inbuf, 1, sizeof(inbuf),
					infile);

			if (ferror(infile)) {
				fprintf(stderr,
					"Error reading from '%s': %s\n",
					filename, strerror(errno));
				return false;
			}

			// We don't need to care about hitting the end of
			// the file so no need to check for feof().
		}

		ret = lzma_code(strm, LZMA_RUN);

		switch (ret) {
		case LZMA_OK:
			break;

		case LZMA_SEEK_NEEDED:
			// The cast is safe because liblzma won't ask us to
			// seek past the known size of the input file which
			// did fit into a long.
			//
			// NOTE: Remember to change these to off_t if you
			// switch fseeko() or lseek().
			if (fseek(infile, (long)(strm->seek_pos), SEEK_SET)) {
				fprintf(stderr, "Error seeking the "
						"file '%s': %s\n",
						filename, strerror(errno));
				return false;
			}

			// The old data in the inbuf is useless now. Set
			// avail_in to zero so that we will read new input
			// from the new file position on the next iteration
			// of this loop.
			strm->avail_in = 0;
			break;

		case LZMA_STREAM_END:
			// File information was successfully decoded.
			// See <lzma/index.h> for functions that can be
			// used on it. In this example we just print
			// the uncompressed size (in bytes) of
			// the .xz file followed by its file name.
			printf("%10" PRIu64 " %s\n",
					lzma_index_uncompressed_size(i),
					filename);

			// Free the memory of the lzma_index structure.
			lzma_index_end(i, NULL);

			return true;

		case LZMA_FORMAT_ERROR:
			// .xz magic bytes weren't found.
			fprintf(stderr, "The file '%s' is not "
					"in the .xz format\n", filename);
			return false;

		case LZMA_OPTIONS_ERROR:
			fprintf(stderr, "The file '%s' has .xz headers that "
					"are not supported by this liblzma "
					"version\n", filename);
			return false;

		case LZMA_DATA_ERROR:
			fprintf(stderr, "The file '%s' is corrupt\n",
					filename);
			return false;

		case LZMA_MEM_ERROR:
			fprintf(stderr, "Memory allocation failed when "
					"decoding the file '%s'\n", filename);
			return false;

		// LZMA_MEMLIMIT_ERROR shouldn't happen because we used
		// UINT64_MAX as the limit.
		//
		// LZMA_BUF_ERROR shouldn't happen because we always provide
		// new input when the input buffer is empty. The decoder
		// knows the input file size and thus won't try to read past
		// the end of the file.
		case LZMA_MEMLIMIT_ERROR:
		case LZMA_BUF_ERROR:
		case LZMA_PROG_ERROR:
		default:
			fprintf(stderr, "Unknown error, possibly a bug\n");
			return false;
		}
	}

	// This line is never reached.
}


extern int
main(int argc, char **argv)
{
	bool success = true;
	lzma_stream strm = LZMA_STREAM_INIT;

	for (int i = 1; i < argc; ++i) {
		FILE *infile = fopen(argv[i], "rb");

		if (infile == NULL) {
			fprintf(stderr, "Cannot open the file '%s': %s\n",
					argv[i], strerror(errno));
			success = false;
		}

		success &= print_file_size(&strm, infile, argv[i]);

		(void)fclose(infile);
	}

	lzma_end(&strm);

	// Close stdout to catch possible write errors that can occur
	// when pending data is flushed from the stdio buffers.
	if (fclose(stdout)) {
		fprintf(stderr, "Write error: %s\n", strerror(errno));
		success = false;
	}

	return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
