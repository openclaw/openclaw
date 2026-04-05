# use pkg-config for getting CFLAGS and LDLIBS
FFMPEG_LIBS=    libavdevice                        \
                libavformat                        \
                libavfilter                        \
                libavcodec                         \
                libswresample                      \
                libswscale                         \
                libavutil                          \

CFLAGS += -Wall -g
CFLAGS := $(shell pkg-config --cflags $(FFMPEG_LIBS)) $(CFLAGS)
LDLIBS := $(shell pkg-config --libs $(FFMPEG_LIBS)) $(LDLIBS)

# missing the following targets, since they need special options in the FFmpeg build:
# qsv_decode
# qsv_transcode
# vaapi_encode
# vaapi_transcode

EXAMPLES=\
                avio_http_serve_files              \
                avio_list_dir                      \
                avio_read_callback                 \
                decode_audio                       \
                decode_filter_audio                \
                decode_filter_video                \
                decode_video                       \
                demux_decode                       \
                encode_audio                       \
                encode_video                       \
                extract_mvs                        \
                hw_decode                          \
                mux                                \
                remux                              \
                resample_audio                     \
                scale_video                        \
                show_metadata                      \
                transcode_aac                      \
                transcode

OBJS=$(addsuffix .o,$(EXAMPLES))

# the following examples make explicit use of the math library
avcodec:           LDLIBS += -lm
encode_audio:      LDLIBS += -lm
mux:               LDLIBS += -lm
resample_audio:    LDLIBS += -lm

.phony: all clean-test clean

all: $(OBJS) $(EXAMPLES)

clean-test:
	$(RM) test*.pgm test.h264 test.mp2 test.sw test.mpg

clean: clean-test
	$(RM) $(EXAMPLES) $(OBJS)
