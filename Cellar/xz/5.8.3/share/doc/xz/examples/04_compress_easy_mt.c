// SPDX-License-Identifier: 0BSD

///////////////////////////////////////////////////////////////////////////////
//
/// \file       04_compress_easy_mt.c
/// \brief      Compress in multi-call mode using LZMA2 in multi-threaded mode
///
/// Usage:      ./04_compress_easy_mt < INFILE > OUTFILE
///
/// Example:    ./04_compress_easy_mt < foo > foo.xz
//
//  Author:     Lasse Collin
//
///////////////////////////////////////////////////////////////////////////////

#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <lzma.h>


static bool
init_encoder(lzma_stream *strm)
{
	// The threaded encoder takes the options as pointer to
	// a lzma_mt structure.
	lzma_mt mt = {
		// No flags are needed.
		.flags = 0,

		// Let liblzma determine a sane block size.
		.block_size = 0,

		// Use no timeout for lzma_code() calls by setting timeout
		// to zero. That is, sometimes lzma_code() might block for
		// a long time (from several seconds to even minutes).
		// If this is not OK, for example due to progress indicator
		// needing updates, specify a timeout in milliseconds here.
		// See the documentation of lzma_mt in lzma/container.h for
		// information how to choose a reasonable timeout.
		.timeout = 0,

		// Use the default preset (6) for LZMA2.
		// To use a preset, filters must be set to NULL.
		.preset = LZMA_PRESET_DEFAULT,
		.filters = NULL,

		// Use CRC64 for integrity checking. See also
		// 01_compress_easy.c about choosing the integrity check.
		.check = LZMA_CHECK_CRC64,
	};

	// Detect how many threads the CPU supports.
	mt.threads = lzma_cputhreads();

	// If the number of CPU cores/threads cannot be detected,
	// use one thread. Note that this isn't the same as the normal
	// single-threaded mode as this will still split the data into
	// blocks and use more RAM than the normal single-threaded mode.
	// You may want to consider using lzma_easy_encoder() or
	// lzma_stream_encoder() instead of lzma_stream_encoder_mt() if
	// lzma_cputhreads() returns 0 or 1.
	if (mt.threads == 0)
		mt.threads = 1;

	// If the number of CPU cores/threads exceeds threads_max,
	// limit the number of threads to keep memory usage lower.
	// The number 8 is arbitrarily chosen and may be too low or
	// high depending on the compression preset and the computer
	// being used.
	//
	// FIXME: A better way could be to check the amount of RAM
	// (or available RAM) and use lzma_stream_encoder_mt_memusage()
	// to determine if the number of threads should be reduced.
	const uint32_t threads_max = 8;
	if (mt.threads > threads_max)
		mt.threads = threads_max;

	// Initialize the threaded encoder.
	lzma_ret ret = lzma_stream_encoder_mt(strm, &mt);

	if (ret == LZMA_OK)
		return true;

	const char *msg;
	switch (ret) {
	case LZMA_MEM_ERROR:
		msg = "Memory allocation failed";
		break;

	case LZMA_OPTIONS_ERROR:
		// We are no longer using a plain preset so this error
		// message has been edited accordingly compared to
		// 01_compress_easy.c.
		msg = "Specified filter chain is not supported";
		break;

	case LZMA_UNSUPPORTED_CHECK:
		msg = "Specified integrity check is not supported";
		break;

	default:
		msg = "Unknown error, possibly a bug";
		break;
	}

	fprintf(stderr, "Error initializing the encoder: %s (error code %u)\n",
			msg, ret);
	return false;
}


// This function is identical to the one in 01_compress_easy.c.
static bool
compress(lzma_stream *strm, FILE *infile, FILE *outfile)
{
	lzma_action action = LZMA_RUN;

	uint8_t inbuf[BUFSIZ];
	uint8_t outbuf[BUFSIZ];

	strm->next_in = NULL;
	strm->avail_in = 0;
	strm->next_out = outbuf;
	strm->avail_out = sizeof(outbuf);

	while (true) {
		if (strm->avail_in == 0 && !feof(infile)) {
			strm->next_in = inbuf;
			strm->avail_in = fread(inbuf, 1, sizeof(inbuf),
					infile);

			if (ferror(infile)) {
				fprintf(stderr, "Read error: %s\n",
						strerror(errno));
				return false;
			}

			if (feof(infile))
				action = LZMA_FINISH;
		}

		lzma_ret ret = lzma_code(strm, action);

		if (strm->avail_out == 0 || ret == LZMA_STREAM_END) {
			size_t write_size = sizeof(outbuf) - strm->avail_out;

			if (fwrite(outbuf, 1, write_size, outfile)
					!= write_size) {
				fprintf(stderr, "Write error: %s\n",
						strerror(errno));
				return false;
			}

			strm->next_out = outbuf;
			strm->avail_out = sizeof(outbuf);
		}

		if (ret != LZMA_OK) {
			if (ret == LZMA_STREAM_END)
				return true;

			const char *msg;
			switch (ret) {
			case LZMA_MEM_ERROR:
				msg = "Memory allocation failed";
				break;

			case LZMA_DATA_ERROR:
				msg = "File size limits exceeded";
				break;

			default:
				msg = "Unknown error, possibly a bug";
				break;
			}

			fprintf(stderr, "Encoder error: %s (error code %u)\n",
					msg, ret);
			return false;
		}
	}
}


extern int
main(void)
{
	lzma_stream strm = LZMA_STREAM_INIT;

	bool success = init_encoder(&strm);
	if (success)
		success = compress(&strm, stdin, stdout);

	lzma_end(&strm);

	if (fclose(stdout)) {
		fprintf(stderr, "Write error: %s\n", strerror(errno));
		success = false;
	}

	return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
