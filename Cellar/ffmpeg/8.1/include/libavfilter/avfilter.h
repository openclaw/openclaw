/*
 * filter layer
 * Copyright (c) 2007 Bobby Bingham
 *
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

#ifndef AVFILTER_AVFILTER_H
#define AVFILTER_AVFILTER_H

/**
 * @file
 * @ingroup lavfi
 * Main libavfilter public API header
 */

/**
 * @defgroup lavfi libavfilter
 * Graph-based frame editing library.
 *
 * @{
 */

#include <stddef.h>

#include "libavutil/attributes.h"
#include "libavutil/avutil.h"
#include "libavutil/buffer.h"
#include "libavutil/dict.h"
#include "libavutil/frame.h"
#include "libavutil/log.h"
#include "libavutil/pixfmt.h"
#include "libavutil/rational.h"

#include "libavfilter/version_major.h"
#ifndef HAVE_AV_CONFIG_H
/* When included as part of the ffmpeg build, only include the major version
 * to avoid unnecessary rebuilds. When included externally, keep including
 * the full version information. */
#include "libavfilter/version.h"
#endif

/**
 * Return the LIBAVFILTER_VERSION_INT constant.
 */
unsigned avfilter_version(void);

/**
 * Return the libavfilter build-time configuration.
 */
const char *avfilter_configuration(void);

/**
 * Return the libavfilter license.
 */
const char *avfilter_license(void);

typedef struct AVFilterLink    AVFilterLink;
typedef struct AVFilterPad     AVFilterPad;
typedef struct AVFilterFormats AVFilterFormats;
typedef struct AVFilterChannelLayouts AVFilterChannelLayouts;

/**
 * Get the name of an AVFilterPad.
 *
 * @param pads an array of AVFilterPads
 * @param pad_idx index of the pad in the array; it is the caller's
 *                responsibility to ensure the index is valid
 *
 * @return name of the pad_idx'th pad in pads
 */
const char *avfilter_pad_get_name(const AVFilterPad *pads, int pad_idx);

/**
 * Get the type of an AVFilterPad.
 *
 * @param pads an array of AVFilterPads
 * @param pad_idx index of the pad in the array; it is the caller's
 *                responsibility to ensure the index is valid
 *
 * @return type of the pad_idx'th pad in pads
 */
enum AVMediaType avfilter_pad_get_type(const AVFilterPad *pads, int pad_idx);

/**
 * Get the hardware frames context of a filter link.
 *
 * @param link an AVFilterLink
 *
 * @return a ref-counted copy of the link's hw_frames_ctx field if there is
 *         a hardware frames context associated with the link or NULL otherwise.
 *         The returned AVBufferRef needs to be released with av_buffer_unref()
 *         when it is no longer used.
 */
AVBufferRef* avfilter_link_get_hw_frames_ctx(AVFilterLink *link);

/**
 * Lists of formats / etc. supported by an end of a link.
 *
 * This structure is directly part of AVFilterLink, in two copies:
 * one for the source filter, one for the destination filter.

 * These lists are used for negotiating the format to actually be used,
 * which will be loaded into the format and channel_layout members of
 * AVFilterLink, when chosen.
 */
typedef struct AVFilterFormatsConfig {

    /**
     * List of supported formats (pixel or sample).
     */
    AVFilterFormats *formats;

    /**
     * Lists of supported sample rates, only for audio.
     */
    AVFilterFormats  *samplerates;

    /**
     * Lists of supported channel layouts, only for audio.
     */
    AVFilterChannelLayouts  *channel_layouts;

    /**
     * Lists of supported YUV color metadata, only for YUV video.
     */
    AVFilterFormats *color_spaces;  ///< AVColorSpace
    AVFilterFormats *color_ranges;  ///< AVColorRange

    /**
     * List of supported alpha modes, only for video with an alpha channel.
     */
    AVFilterFormats *alpha_modes;  ///< AVAlphaMode

} AVFilterFormatsConfig;

/**
 * The number of the filter inputs is not determined just by AVFilter.inputs.
 * The filter might add additional inputs during initialization depending on the
 * options supplied to it.
 */
#define AVFILTER_FLAG_DYNAMIC_INPUTS        (1 << 0)
/**
 * The number of the filter outputs is not determined just by AVFilter.outputs.
 * The filter might add additional outputs during initialization depending on
 * the options supplied to it.
 */
#define AVFILTER_FLAG_DYNAMIC_OUTPUTS       (1 << 1)
/**
 * The filter supports multithreading by splitting frames into multiple parts
 * and processing them concurrently.
 */
#define AVFILTER_FLAG_SLICE_THREADS         (1 << 2)
/**
 * The filter is a "metadata" filter - it does not modify the frame data in any
 * way. It may only affect the metadata (i.e. those fields copied by
 * av_frame_copy_props()).
 *
 * More precisely, this means:
 * - video: the data of any frame output by the filter must be exactly equal to
 *   some frame that is received on one of its inputs. Furthermore, all frames
 *   produced on a given output must correspond to frames received on the same
 *   input and their order must be unchanged. Note that the filter may still
 *   drop or duplicate the frames.
 * - audio: the data produced by the filter on any of its outputs (viewed e.g.
 *   as an array of interleaved samples) must be exactly equal to the data
 *   received by the filter on one of its inputs.
 */
#define AVFILTER_FLAG_METADATA_ONLY         (1 << 3)

/**
 * The filter can create hardware frames using AVFilterContext.hw_device_ctx.
 */
#define AVFILTER_FLAG_HWDEVICE              (1 << 4)
/**
 * Some filters support a generic "enable" expression option that can be used
 * to enable or disable a filter in the timeline. Filters supporting this
 * option have this flag set. When the enable expression is false, the default
 * no-op filter_frame() function is called in place of the filter_frame()
 * callback defined on each input pad, thus the frame is passed unchanged to
 * the next filters.
 */
#define AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC  (1 << 16)
/**
 * Same as AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC, except that the filter will
 * have its filter_frame() callback(s) called as usual even when the enable
 * expression is false. The filter will disable filtering within the
 * filter_frame() callback(s) itself, for example executing code depending on
 * the AVFilterContext->is_disabled value.
 */
#define AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL (1 << 17)
/**
 * Handy mask to test whether the filter supports or no the timeline feature
 * (internally or generically).
 */
#define AVFILTER_FLAG_SUPPORT_TIMELINE (AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC | AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL)

/**
 * Filter definition. This defines the pads a filter contains, and all the
 * callback functions used to interact with the filter.
 */
typedef struct AVFilter {
    /**
     * Filter name. Must be non-NULL and unique among filters.
     */
    const char *name;

    /**
     * A description of the filter. May be NULL.
     *
     * You should use the NULL_IF_CONFIG_SMALL() macro to define it.
     */
    const char *description;

    /**
     * List of static inputs.
     *
     * NULL if there are no (static) inputs. Instances of filters with
     * AVFILTER_FLAG_DYNAMIC_INPUTS set may have more inputs than present in
     * this list.
     */
    const AVFilterPad *inputs;

    /**
     * List of static outputs.
     *
     * NULL if there are no (static) outputs. Instances of filters with
     * AVFILTER_FLAG_DYNAMIC_OUTPUTS set may have more outputs than present in
     * this list.
     */
    const AVFilterPad *outputs;

    /**
     * A class for the private data, used to declare filter private AVOptions.
     * This field is NULL for filters that do not declare any options.
     *
     * If this field is non-NULL, the first member of the filter private data
     * must be a pointer to AVClass, which will be set by libavfilter generic
     * code to this class.
     */
    const AVClass *priv_class;

    /**
     * A combination of AVFILTER_FLAG_*
     */
    int flags;
} AVFilter;

/**
 * Get the number of elements in an AVFilter's inputs or outputs array.
 */
unsigned avfilter_filter_pad_count(const AVFilter *filter, int is_output);

/**
 * Process multiple parts of the frame concurrently.
 */
#define AVFILTER_THREAD_SLICE (1 << 0)

/** An instance of a filter */
typedef struct AVFilterContext {
    const AVClass *av_class;        ///< needed for av_log() and filters common options

    const AVFilter *filter;         ///< the AVFilter of which this is an instance

    char *name;                     ///< name of this filter instance

    AVFilterPad   *input_pads;      ///< array of input pads
    AVFilterLink **inputs;          ///< array of pointers to input links
    unsigned    nb_inputs;          ///< number of input pads

    AVFilterPad   *output_pads;     ///< array of output pads
    AVFilterLink **outputs;         ///< array of pointers to output links
    unsigned    nb_outputs;         ///< number of output pads

    void *priv;                     ///< private data for use by the filter

    struct AVFilterGraph *graph;    ///< filtergraph this filter belongs to

    /**
     * Type of multithreading being allowed/used. A combination of
     * AVFILTER_THREAD_* flags.
     *
     * May be set by the caller before initializing the filter to forbid some
     * or all kinds of multithreading for this filter. The default is allowing
     * everything.
     *
     * When the filter is initialized, this field is combined using bit AND with
     * AVFilterGraph.thread_type to get the final mask used for determining
     * allowed threading types. I.e. a threading type needs to be set in both
     * to be allowed.
     *
     * After the filter is initialized, libavfilter sets this field to the
     * threading type that is actually used (0 for no multithreading).
     */
    int thread_type;

    /**
     * Max number of threads allowed in this filter instance.
     * If <= 0, its value is ignored.
     * Overrides global number of threads set per filter graph.
     */
    int nb_threads;

#if FF_API_CONTEXT_PUBLIC
    /**
     * @deprecated unused
     */
    attribute_deprecated
    struct AVFilterCommand *command_queue;
#endif

    char *enable_str;               ///< enable expression string
#if FF_API_CONTEXT_PUBLIC
    /**
     * @deprecated unused
     */
    attribute_deprecated
    void *enable;
    /**
     * @deprecated unused
     */
    double *var_values;
#endif
    /**
     * MUST NOT be accessed from outside avfilter.
     *
     * the enabled state from the last expression evaluation
     */
    int is_disabled;

    /**
     * For filters which will create hardware frames, sets the device the
     * filter should create them in.  All other filters will ignore this field:
     * in particular, a filter which consumes or processes hardware frames will
     * instead use the hw_frames_ctx field in AVFilterLink to carry the
     * hardware context information.
     *
     * May be set by the caller on filters flagged with AVFILTER_FLAG_HWDEVICE
     * before initializing the filter with avfilter_init_str() or
     * avfilter_init_dict().
     */
    AVBufferRef *hw_device_ctx;

#if FF_API_CONTEXT_PUBLIC
    /**
     * @deprecated this field should never have been accessed by callers
     */
    attribute_deprecated
    unsigned ready;
#endif

    /**
     * Sets the number of extra hardware frames which the filter will
     * allocate on its output links for use in following filters or by
     * the caller.
     *
     * Some hardware filters require all frames that they will use for
     * output to be defined in advance before filtering starts.  For such
     * filters, any hardware frame pools used for output must therefore be
     * of fixed size.  The extra frames set here are on top of any number
     * that the filter needs internally in order to operate normally.
     *
     * This field must be set before the graph containing this filter is
     * configured.
     */
    int extra_hw_frames;
} AVFilterContext;

/**
 * A link between two filters. This contains pointers to the source and
 * destination filters between which this link exists, and the indexes of
 * the pads involved. In addition, this link also contains the parameters
 * which have been negotiated and agreed upon between the filter, such as
 * image dimensions, format, etc.
 *
 * Applications must not normally access the link structure directly.
 * Use the buffersrc and buffersink API instead.
 * In the future, access to the header may be reserved for filters
 * implementation.
 */
struct AVFilterLink {
    AVFilterContext *src;       ///< source filter
    AVFilterPad *srcpad;        ///< output pad on the source filter

    AVFilterContext *dst;       ///< dest filter
    AVFilterPad *dstpad;        ///< input pad on the dest filter

    enum AVMediaType type;      ///< filter media type

    int format;                 ///< agreed upon media format

    /* These parameters apply only to video */
    int w;                      ///< agreed upon image width
    int h;                      ///< agreed upon image height
    AVRational sample_aspect_ratio; ///< agreed upon sample aspect ratio
    /**
     * For non-YUV links, these are respectively set to fallback values (as
     * appropriate for that colorspace).
     *
     * Note: This includes grayscale formats, as these are currently treated
     * as forced full range always.
     */
    enum AVColorSpace colorspace;   ///< agreed upon YUV color space
    enum AVColorRange color_range;  ///< agreed upon YUV color range

    /* These parameters apply only to audio */
    int sample_rate;            ///< samples per second
    AVChannelLayout ch_layout;  ///< channel layout of current buffer (see libavutil/channel_layout.h)

    /**
     * Define the time base used by the PTS of the frames/samples
     * which will pass through this link.
     * During the configuration stage, each filter is supposed to
     * change only the output timebase, while the timebase of the
     * input link is assumed to be an unchangeable property.
     */
    AVRational time_base;

    AVFrameSideData **side_data;
    int nb_side_data;

    enum AVAlphaMode alpha_mode; ///< alpha mode (for videos with an alpha channel)

    /*****************************************************************
     * All fields below this line are not part of the public API. They
     * may not be used outside of libavfilter and can be changed and
     * removed at will.
     * New public fields should be added right above.
     *****************************************************************
     */

    /**
     * Lists of supported formats / etc. supported by the input filter.
     */
    AVFilterFormatsConfig incfg;

    /**
     * Lists of supported formats / etc. supported by the output filter.
     */
    AVFilterFormatsConfig outcfg;
};

/**
 * Link two filters together.
 *
 * @param src    the source filter
 * @param srcpad index of the output pad on the source filter
 * @param dst    the destination filter
 * @param dstpad index of the input pad on the destination filter
 * @return       zero on success
 */
int avfilter_link(AVFilterContext *src, unsigned srcpad,
                  AVFilterContext *dst, unsigned dstpad);

#define AVFILTER_CMD_FLAG_ONE   1 ///< Stop once a filter understood the command (for target=all for example), fast filters are favored automatically
#define AVFILTER_CMD_FLAG_FAST  2 ///< Only execute command when its fast (like a video out that supports contrast adjustment in hw)

/**
 * Make the filter instance process a command.
 * It is recommended to use avfilter_graph_send_command().
 */
int avfilter_process_command(AVFilterContext *filter, const char *cmd, const char *arg, char *res, int res_len, int flags);

/**
 * Iterate over all registered filters.
 *
 * @param opaque a pointer where libavfilter will store the iteration state. Must
 *               point to NULL to start the iteration.
 *
 * @return the next registered filter or NULL when the iteration is
 *         finished
 */
const AVFilter *av_filter_iterate(void **opaque);

/**
 * Get a filter definition matching the given name.
 *
 * @param name the filter name to find
 * @return     the filter definition, if any matching one is registered.
 *             NULL if none found.
 */
const AVFilter *avfilter_get_by_name(const char *name);


/**
 * Initialize a filter with the supplied parameters.
 *
 * @param ctx  uninitialized filter context to initialize
 * @param args Options to initialize the filter with. This must be a
 *             ':'-separated list of options in the 'key=value' form.
 *             May be NULL if the options have been set directly using the
 *             AVOptions API or there are no options that need to be set.
 * @return 0 on success, a negative AVERROR on failure
 */
int avfilter_init_str(AVFilterContext *ctx, const char *args);

/**
 * Initialize a filter with the supplied dictionary of options.
 *
 * @param ctx     uninitialized filter context to initialize
 * @param options An AVDictionary filled with options for this filter. On
 *                return this parameter will be destroyed and replaced with
 *                a dict containing options that were not found. This dictionary
 *                must be freed by the caller.
 *                May be NULL, then this function is equivalent to
 *                avfilter_init_str() with the second parameter set to NULL.
 * @return 0 on success, a negative AVERROR on failure
 *
 * @note This function and avfilter_init_str() do essentially the same thing,
 * the difference is in manner in which the options are passed. It is up to the
 * calling code to choose whichever is more preferable. The two functions also
 * behave differently when some of the provided options are not declared as
 * supported by the filter. In such a case, avfilter_init_str() will fail, but
 * this function will leave those extra options in the options AVDictionary and
 * continue as usual.
 */
int avfilter_init_dict(AVFilterContext *ctx, AVDictionary **options);

/**
 * Free a filter context. This will also remove the filter from its
 * filtergraph's list of filters.
 *
 * @param filter the filter to free
 */
void avfilter_free(AVFilterContext *filter);

/**
 * Insert a filter in the middle of an existing link.
 *
 * @param link the link into which the filter should be inserted
 * @param filt the filter to be inserted
 * @param filt_srcpad_idx the input pad on the filter to connect
 * @param filt_dstpad_idx the output pad on the filter to connect
 * @return     zero on success
 */
int avfilter_insert_filter(AVFilterLink *link, AVFilterContext *filt,
                           unsigned filt_srcpad_idx, unsigned filt_dstpad_idx);

/**
 * @return AVClass for AVFilterContext.
 *
 * @see av_opt_find().
 */
const AVClass *avfilter_get_class(void);

/**
 * A function pointer passed to the @ref AVFilterGraph.execute callback to be
 * executed multiple times, possibly in parallel.
 *
 * @param ctx the filter context the job belongs to
 * @param arg an opaque parameter passed through from @ref
 *            AVFilterGraph.execute
 * @param jobnr the index of the job being executed
 * @param nb_jobs the total number of jobs
 *
 * @return 0 on success, a negative AVERROR on error
 */
typedef int (avfilter_action_func)(AVFilterContext *ctx, void *arg, int jobnr, int nb_jobs);

/**
 * A function executing multiple jobs, possibly in parallel.
 *
 * @param ctx the filter context to which the jobs belong
 * @param func the function to be called multiple times
 * @param arg the argument to be passed to func
 * @param ret a nb_jobs-sized array to be filled with return values from each
 *            invocation of func
 * @param nb_jobs the number of jobs to execute
 *
 * @return 0 on success, a negative AVERROR on error
 */
typedef int (avfilter_execute_func)(AVFilterContext *ctx, avfilter_action_func *func,
                                    void *arg, int *ret, int nb_jobs);

typedef struct AVFilterGraph {
    const AVClass *av_class;
    AVFilterContext **filters;
    unsigned nb_filters;

    char *scale_sws_opts; ///< sws options to use for the auto-inserted scale filters

    /**
     * Type of multithreading allowed for filters in this graph. A combination
     * of AVFILTER_THREAD_* flags.
     *
     * May be set by the caller at any point, the setting will apply to all
     * filters initialized after that. The default is allowing everything.
     *
     * When a filter in this graph is initialized, this field is combined using
     * bit AND with AVFilterContext.thread_type to get the final mask used for
     * determining allowed threading types. I.e. a threading type needs to be
     * set in both to be allowed.
     */
    int thread_type;

    /**
     * Maximum number of threads used by filters in this graph. May be set by
     * the caller before adding any filters to the filtergraph. Zero (the
     * default) means that the number of threads is determined automatically.
     */
    int nb_threads;

    /**
     * Opaque user data. May be set by the caller to an arbitrary value, e.g. to
     * be used from callbacks like @ref AVFilterGraph.execute.
     * Libavfilter will not touch this field in any way.
     */
    void *opaque;

    /**
     * This callback may be set by the caller immediately after allocating the
     * graph and before adding any filters to it, to provide a custom
     * multithreading implementation.
     *
     * If set, filters with slice threading capability will call this callback
     * to execute multiple jobs in parallel.
     *
     * If this field is left unset, libavfilter will use its internal
     * implementation, which may or may not be multithreaded depending on the
     * platform and build options.
     */
    avfilter_execute_func *execute;

    char *aresample_swr_opts; ///< swr options to use for the auto-inserted aresample filters, Access ONLY through AVOptions

    /**
     * Sets the maximum number of buffered frames in the filtergraph combined.
     *
     * Zero means no limit. This field must be set before calling
     * avfilter_graph_config().
     */
    unsigned max_buffered_frames;
} AVFilterGraph;

/**
 * Allocate a filter graph.
 *
 * @return the allocated filter graph on success or NULL.
 */
AVFilterGraph *avfilter_graph_alloc(void);

/**
 * Create a new filter instance in a filter graph.
 *
 * @param graph graph in which the new filter will be used
 * @param filter the filter to create an instance of
 * @param name Name to give to the new instance (will be copied to
 *             AVFilterContext.name). This may be used by the caller to identify
 *             different filters, libavfilter itself assigns no semantics to
 *             this parameter. May be NULL.
 *
 * @return the context of the newly created filter instance (note that it is
 *         also retrievable directly through AVFilterGraph.filters or with
 *         avfilter_graph_get_filter()) on success or NULL on failure.
 */
AVFilterContext *avfilter_graph_alloc_filter(AVFilterGraph *graph,
                                             const AVFilter *filter,
                                             const char *name);

/**
 * Get a filter instance identified by instance name from graph.
 *
 * @param graph filter graph to search through.
 * @param name filter instance name (should be unique in the graph).
 * @return the pointer to the found filter instance or NULL if it
 * cannot be found.
 */
AVFilterContext *avfilter_graph_get_filter(AVFilterGraph *graph, const char *name);

/**
 * A convenience wrapper that allocates and initializes a filter in a single
 * step. The filter instance is created from the filter filt and inited with the
 * parameter args. opaque is currently ignored.
 *
 * In case of success put in *filt_ctx the pointer to the created
 * filter instance, otherwise set *filt_ctx to NULL.
 *
 * @param name the instance name to give to the created filter instance
 * @param graph_ctx the filter graph
 * @return a negative AVERROR error code in case of failure, a non
 * negative value otherwise
 *
 * @warning Since the filter is initialized after this function successfully
 *          returns, you MUST NOT set any further options on it. If you need to
 *          do that, call ::avfilter_graph_alloc_filter(), followed by setting
 *          the options, followed by ::avfilter_init_dict() instead of this
 *          function.
 */
int avfilter_graph_create_filter(AVFilterContext **filt_ctx, const AVFilter *filt,
                                 const char *name, const char *args, void *opaque,
                                 AVFilterGraph *graph_ctx);

/**
 * Enable or disable automatic format conversion inside the graph.
 *
 * Note that format conversion can still happen inside explicitly inserted
 * scale and aresample filters.
 *
 * @param flags  any of the AVFILTER_AUTO_CONVERT_* constants
 */
void avfilter_graph_set_auto_convert(AVFilterGraph *graph, unsigned flags);

enum {
    AVFILTER_AUTO_CONVERT_ALL  =  0, /**< all automatic conversions enabled */
    AVFILTER_AUTO_CONVERT_NONE = -1, /**< all automatic conversions disabled */
};

/**
 * Check validity and configure all the links and formats in the graph.
 *
 * @param graphctx the filter graph
 * @param log_ctx context used for logging
 * @return >= 0 in case of success, a negative AVERROR code otherwise
 */
int avfilter_graph_config(AVFilterGraph *graphctx, void *log_ctx);

/**
 * Free a graph, destroy its links, and set *graph to NULL.
 * If *graph is NULL, do nothing.
 */
void avfilter_graph_free(AVFilterGraph **graph);

/**
 * A linked-list of the inputs/outputs of the filter chain.
 *
 * This is mainly useful for avfilter_graph_parse() / avfilter_graph_parse2(),
 * where it is used to communicate open (unlinked) inputs and outputs from and
 * to the caller.
 * This struct specifies, per each not connected pad contained in the graph, the
 * filter context and the pad index required for establishing a link.
 */
typedef struct AVFilterInOut {
    /** unique name for this input/output in the list */
    char *name;

    /** filter context associated to this input/output */
    AVFilterContext *filter_ctx;

    /** index of the filt_ctx pad to use for linking */
    int pad_idx;

    /** next input/input in the list, NULL if this is the last */
    struct AVFilterInOut *next;
} AVFilterInOut;

/**
 * Allocate a single AVFilterInOut entry.
 * Must be freed with avfilter_inout_free().
 * @return allocated AVFilterInOut on success, NULL on failure.
 */
AVFilterInOut *avfilter_inout_alloc(void);

/**
 * Free the supplied list of AVFilterInOut and set *inout to NULL.
 * If *inout is NULL, do nothing.
 */
void avfilter_inout_free(AVFilterInOut **inout);

/**
 * Add a graph described by a string to a graph.
 *
 * @note The caller must provide the lists of inputs and outputs,
 * which therefore must be known before calling the function.
 *
 * @note The inputs parameter describes inputs of the already existing
 * part of the graph; i.e. from the point of view of the newly created
 * part, they are outputs. Similarly the outputs parameter describes
 * outputs of the already existing filters, which are provided as
 * inputs to the parsed filters.
 *
 * @param graph   the filter graph where to link the parsed graph context
 * @param filters string to be parsed
 * @param inputs  linked list to the inputs of the graph
 * @param outputs linked list to the outputs of the graph
 * @return zero on success, a negative AVERROR code on error
 */
int avfilter_graph_parse(AVFilterGraph *graph, const char *filters,
                         AVFilterInOut *inputs, AVFilterInOut *outputs,
                         void *log_ctx);

/**
 * Add a graph described by a string to a graph.
 *
 * In the graph filters description, if the input label of the first
 * filter is not specified, "in" is assumed; if the output label of
 * the last filter is not specified, "out" is assumed.
 *
 * @param graph   the filter graph where to link the parsed graph context
 * @param filters string to be parsed
 * @param inputs  pointer to a linked list to the inputs of the graph, may be NULL.
 *                If non-NULL, *inputs is updated to contain the list of open inputs
 *                after the parsing, should be freed with avfilter_inout_free().
 * @param outputs pointer to a linked list to the outputs of the graph, may be NULL.
 *                If non-NULL, *outputs is updated to contain the list of open outputs
 *                after the parsing, should be freed with avfilter_inout_free().
 * @return non negative on success, a negative AVERROR code on error
 */
int avfilter_graph_parse_ptr(AVFilterGraph *graph, const char *filters,
                             AVFilterInOut **inputs, AVFilterInOut **outputs,
                             void *log_ctx);

/**
 * Add a graph described by a string to a graph.
 *
 * @param[in]  graph   the filter graph where to link the parsed graph context
 * @param[in]  filters string to be parsed
 * @param[out] inputs  a linked list of all free (unlinked) inputs of the
 *                     parsed graph will be returned here. It is to be freed
 *                     by the caller using avfilter_inout_free().
 * @param[out] outputs a linked list of all free (unlinked) outputs of the
 *                     parsed graph will be returned here. It is to be freed by the
 *                     caller using avfilter_inout_free().
 * @return zero on success, a negative AVERROR code on error
 *
 * @note This function returns the inputs and outputs that are left
 * unlinked after parsing the graph and the caller then deals with
 * them.
 * @note This function makes no reference whatsoever to already
 * existing parts of the graph and the inputs parameter will on return
 * contain inputs of the newly parsed part of the graph.  Analogously
 * the outputs parameter will contain outputs of the newly created
 * filters.
 */
int avfilter_graph_parse2(AVFilterGraph *graph, const char *filters,
                          AVFilterInOut **inputs,
                          AVFilterInOut **outputs);

/**
 * Parameters of a filter's input or output pad.
 *
 * Created as a child of AVFilterParams by avfilter_graph_segment_parse().
 * Freed in avfilter_graph_segment_free().
 */
typedef struct AVFilterPadParams {
    /**
     * An av_malloc()'ed string containing the pad label.
     *
     * May be av_free()'d and set to NULL by the caller, in which case this pad
     * will be treated as unlabeled for linking.
     * May also be replaced by another av_malloc()'ed string.
     */
    char *label;
} AVFilterPadParams;

/**
 * Parameters describing a filter to be created in a filtergraph.
 *
 * Created as a child of AVFilterGraphSegment by avfilter_graph_segment_parse().
 * Freed in avfilter_graph_segment_free().
 */
typedef struct AVFilterParams {
    /**
     * The filter context.
     *
     * Created by avfilter_graph_segment_create_filters() based on
     * AVFilterParams.filter_name and instance_name.
     *
     * Callers may also create the filter context manually, then they should
     * av_free() filter_name and set it to NULL. Such AVFilterParams instances
     * are then skipped by avfilter_graph_segment_create_filters().
     */
    AVFilterContext     *filter;

    /**
     * Name of the AVFilter to be used.
     *
     * An av_malloc()'ed string, set by avfilter_graph_segment_parse(). Will be
     * passed to avfilter_get_by_name() by
     * avfilter_graph_segment_create_filters().
     *
     * Callers may av_free() this string and replace it with another one or
     * NULL. If the caller creates the filter instance manually, this string
     * MUST be set to NULL.
     *
     * When both AVFilterParams.filter an AVFilterParams.filter_name are NULL,
     * this AVFilterParams instance is skipped by avfilter_graph_segment_*()
     * functions.
     */
    char                *filter_name;
    /**
     * Name to be used for this filter instance.
     *
     * An av_malloc()'ed string, may be set by avfilter_graph_segment_parse() or
     * left NULL. The caller may av_free() this string and replace with another
     * one or NULL.
     *
     * Will be used by avfilter_graph_segment_create_filters() - passed as the
     * third argument to avfilter_graph_alloc_filter(), then freed and set to
     * NULL.
     */
    char                *instance_name;

    /**
     * Options to be applied to the filter.
     *
     * Filled by avfilter_graph_segment_parse(). Afterwards may be freely
     * modified by the caller.
     *
     * Will be applied to the filter by avfilter_graph_segment_apply_opts()
     * with an equivalent of av_opt_set_dict2(filter, &opts, AV_OPT_SEARCH_CHILDREN),
     * i.e. any unapplied options will be left in this dictionary.
     */
    AVDictionary        *opts;

    AVFilterPadParams  **inputs;
    unsigned          nb_inputs;

    AVFilterPadParams  **outputs;
    unsigned          nb_outputs;
} AVFilterParams;

/**
 * A filterchain is a list of filter specifications.
 *
 * Created as a child of AVFilterGraphSegment by avfilter_graph_segment_parse().
 * Freed in avfilter_graph_segment_free().
 */
typedef struct AVFilterChain {
    AVFilterParams  **filters;
    size_t         nb_filters;
} AVFilterChain;

/**
 * A parsed representation of a filtergraph segment.
 *
 * A filtergraph segment is conceptually a list of filterchains, with some
 * supplementary information (e.g. format conversion flags).
 *
 * Created by avfilter_graph_segment_parse(). Must be freed with
 * avfilter_graph_segment_free().
 */
typedef struct AVFilterGraphSegment {
    /**
     * The filtergraph this segment is associated with.
     * Set by avfilter_graph_segment_parse().
     */
    AVFilterGraph *graph;

    /**
     * A list of filter chain contained in this segment.
     * Set in avfilter_graph_segment_parse().
     */
    AVFilterChain **chains;
    size_t       nb_chains;

    /**
     * A string containing a colon-separated list of key=value options applied
     * to all scale filters in this segment.
     *
     * May be set by avfilter_graph_segment_parse().
     * The caller may free this string with av_free() and replace it with a
     * different av_malloc()'ed string.
     */
    char *scale_sws_opts;
} AVFilterGraphSegment;

/**
 * Parse a textual filtergraph description into an intermediate form.
 *
 * This intermediate representation is intended to be modified by the caller as
 * described in the documentation of AVFilterGraphSegment and its children, and
 * then applied to the graph either manually or with other
 * avfilter_graph_segment_*() functions. See the documentation for
 * avfilter_graph_segment_apply() for the canonical way to apply
 * AVFilterGraphSegment.
 *
 * @param graph Filter graph the parsed segment is associated with. Will only be
 *              used for logging and similar auxiliary purposes. The graph will
 *              not be actually modified by this function - the parsing results
 *              are instead stored in seg for further processing.
 * @param graph_str a string describing the filtergraph segment
 * @param flags reserved for future use, caller must set to 0 for now
 * @param seg A pointer to the newly-created AVFilterGraphSegment is written
 *            here on success. The graph segment is owned by the caller and must
 *            be freed with avfilter_graph_segment_free() before graph itself is
 *            freed.
 *
 * @retval "non-negative number" success
 * @retval "negative error code" failure
 */
int avfilter_graph_segment_parse(AVFilterGraph *graph, const char *graph_str,
                                 int flags, AVFilterGraphSegment **seg);

/**
 * Create filters specified in a graph segment.
 *
 * Walk through the creation-pending AVFilterParams in the segment and create
 * new filter instances for them.
 * Creation-pending params are those where AVFilterParams.filter_name is
 * non-NULL (and hence AVFilterParams.filter is NULL). All other AVFilterParams
 * instances are ignored.
 *
 * For any filter created by this function, the corresponding
 * AVFilterParams.filter is set to the newly-created filter context,
 * AVFilterParams.filter_name and AVFilterParams.instance_name are freed and set
 * to NULL.
 *
 * @param seg the filtergraph segment to process
 * @param flags reserved for future use, caller must set to 0 for now
 *
 * @retval "non-negative number" Success, all creation-pending filters were
 *                               successfully created
 * @retval AVERROR_FILTER_NOT_FOUND some filter's name did not correspond to a
 *                                  known filter
 * @retval "another negative error code" other failures
 *
 * @note Calling this function multiple times is safe, as it is idempotent.
 */
int avfilter_graph_segment_create_filters(AVFilterGraphSegment *seg, int flags);

/**
 * Apply parsed options to filter instances in a graph segment.
 *
 * Walk through all filter instances in the graph segment that have option
 * dictionaries associated with them and apply those options with
 * av_opt_set_dict2(..., AV_OPT_SEARCH_CHILDREN). AVFilterParams.opts is
 * replaced by the dictionary output by av_opt_set_dict2(), which should be
 * empty (NULL) if all options were successfully applied.
 *
 * If any options could not be found, this function will continue processing all
 * other filters and finally return AVERROR_OPTION_NOT_FOUND (unless another
 * error happens). The calling program may then deal with unapplied options as
 * it wishes.
 *
 * Any creation-pending filters (see avfilter_graph_segment_create_filters())
 * present in the segment will cause this function to fail. AVFilterParams with
 * no associated filter context are simply skipped.
 *
 * @param seg the filtergraph segment to process
 * @param flags reserved for future use, caller must set to 0 for now
 *
 * @retval "non-negative number" Success, all options were successfully applied.
 * @retval AVERROR_OPTION_NOT_FOUND some options were not found in a filter
 * @retval "another negative error code" other failures
 *
 * @note Calling this function multiple times is safe, as it is idempotent.
 */
int avfilter_graph_segment_apply_opts(AVFilterGraphSegment *seg, int flags);

/**
 * Initialize all filter instances in a graph segment.
 *
 * Walk through all filter instances in the graph segment and call
 * avfilter_init_dict(..., NULL) on those that have not been initialized yet.
 *
 * Any creation-pending filters (see avfilter_graph_segment_create_filters())
 * present in the segment will cause this function to fail. AVFilterParams with
 * no associated filter context or whose filter context is already initialized,
 * are simply skipped.
 *
 * @param seg the filtergraph segment to process
 * @param flags reserved for future use, caller must set to 0 for now
 *
 * @retval "non-negative number" Success, all filter instances were successfully
 *                               initialized
 * @retval "negative error code" failure
 *
 * @note Calling this function multiple times is safe, as it is idempotent.
 */
int avfilter_graph_segment_init(AVFilterGraphSegment *seg, int flags);

/**
 * Link filters in a graph segment.
 *
 * Walk through all filter instances in the graph segment and try to link all
 * unlinked input and output pads. Any creation-pending filters (see
 * avfilter_graph_segment_create_filters()) present in the segment will cause
 * this function to fail. Disabled filters and already linked pads are skipped.
 *
 * Every filter output pad that has a corresponding AVFilterPadParams with a
 * non-NULL label is
 * - linked to the input with the matching label, if one exists;
 * - exported in the outputs linked list otherwise, with the label preserved.
 * Unlabeled outputs are
 * - linked to the first unlinked unlabeled input in the next non-disabled
 *   filter in the chain, if one exists
 * - exported in the outputs linked list otherwise, with NULL label
 *
 * Similarly, unlinked input pads are exported in the inputs linked list.
 *
 * @param seg the filtergraph segment to process
 * @param flags reserved for future use, caller must set to 0 for now
 * @param[out] inputs  a linked list of all free (unlinked) inputs of the
 *                     filters in this graph segment will be returned here. It
 *                     is to be freed by the caller using avfilter_inout_free().
 * @param[out] outputs a linked list of all free (unlinked) outputs of the
 *                     filters in this graph segment will be returned here. It
 *                     is to be freed by the caller using avfilter_inout_free().
 *
 * @retval "non-negative number" success
 * @retval "negative error code" failure
 *
 * @note Calling this function multiple times is safe, as it is idempotent.
 */
int avfilter_graph_segment_link(AVFilterGraphSegment *seg, int flags,
                                AVFilterInOut **inputs,
                                AVFilterInOut **outputs);

/**
 * Apply all filter/link descriptions from a graph segment to the associated filtergraph.
 *
 * This functions is currently equivalent to calling the following in sequence:
 * - avfilter_graph_segment_create_filters();
 * - avfilter_graph_segment_apply_opts();
 * - avfilter_graph_segment_init();
 * - avfilter_graph_segment_link();
 * failing if any of them fails. This list may be extended in the future.
 *
 * Since the above functions are idempotent, the caller may call some of them
 * manually, then do some custom processing on the filtergraph, then call this
 * function to do the rest.
 *
 * @param seg the filtergraph segment to process
 * @param flags reserved for future use, caller must set to 0 for now
 * @param[out] inputs passed to avfilter_graph_segment_link()
 * @param[out] outputs passed to avfilter_graph_segment_link()
 *
 * @retval "non-negative number" success
 * @retval "negative error code" failure
 *
 * @note Calling this function multiple times is safe, as it is idempotent.
 */
int avfilter_graph_segment_apply(AVFilterGraphSegment *seg, int flags,
                                 AVFilterInOut **inputs,
                                 AVFilterInOut **outputs);

/**
 * Free the provided AVFilterGraphSegment and everything associated with it.
 *
 * @param seg double pointer to the AVFilterGraphSegment to be freed. NULL will
 * be written to this pointer on exit from this function.
 *
 * @note
 * The filter contexts (AVFilterParams.filter) are owned by AVFilterGraph rather
 * than AVFilterGraphSegment, so they are not freed.
 */
void avfilter_graph_segment_free(AVFilterGraphSegment **seg);

/**
 * Send a command to one or more filter instances.
 *
 * @param graph  the filter graph
 * @param target the filter(s) to which the command should be sent
 *               "all" sends to all filters
 *               otherwise it can be a filter or filter instance name
 *               which will send the command to all matching filters.
 * @param cmd    the command to send, for handling simplicity all commands must be alphanumeric only
 * @param arg    the argument for the command
 * @param res    a buffer with size res_size where the filter(s) can return a response.
 *
 * @returns >=0 on success otherwise an error code.
 *              AVERROR(ENOSYS) on unsupported commands
 */
int avfilter_graph_send_command(AVFilterGraph *graph, const char *target, const char *cmd, const char *arg, char *res, int res_len, int flags);

/**
 * Queue a command for one or more filter instances.
 *
 * @param graph  the filter graph
 * @param target the filter(s) to which the command should be sent
 *               "all" sends to all filters
 *               otherwise it can be a filter or filter instance name
 *               which will send the command to all matching filters.
 * @param cmd    the command to sent, for handling simplicity all commands must be alphanumeric only
 * @param arg    the argument for the command
 * @param ts     time at which the command should be sent to the filter
 *
 * @note As this executes commands after this function returns, no return code
 *       from the filter is provided, also AVFILTER_CMD_FLAG_ONE is not supported.
 */
int avfilter_graph_queue_command(AVFilterGraph *graph, const char *target, const char *cmd, const char *arg, int flags, double ts);


/**
 * Dump a graph into a human-readable string representation.
 *
 * @param graph    the graph to dump
 * @param options  formatting options; currently ignored
 * @return  a string, or NULL in case of memory allocation failure;
 *          the string must be freed using av_free
 */
char *avfilter_graph_dump(AVFilterGraph *graph, const char *options);

/**
 * Request a frame on the oldest sink link.
 *
 * If the request returns AVERROR_EOF, try the next.
 *
 * Note that this function is not meant to be the sole scheduling mechanism
 * of a filtergraph, only a convenience function to help drain a filtergraph
 * in a balanced way under normal circumstances.
 *
 * Also note that AVERROR_EOF does not mean that frames did not arrive on
 * some of the sinks during the process.
 * When there are multiple sink links, in case the requested link
 * returns an EOF, this may cause a filter to flush pending frames
 * which are sent to another sink link, although unrequested.
 *
 * @return  the return value of ff_request_frame(),
 *          or AVERROR_EOF if all links returned AVERROR_EOF
 */
int avfilter_graph_request_oldest(AVFilterGraph *graph);

/**
 * @}
 */

#endif /* AVFILTER_AVFILTER_H */
