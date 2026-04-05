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

#ifndef AVUTIL_HWCONTEXT_VULKAN_H
#define AVUTIL_HWCONTEXT_VULKAN_H

#if defined(_WIN32) && !defined(VK_USE_PLATFORM_WIN32_KHR)
#define VK_USE_PLATFORM_WIN32_KHR
#endif
#include <vulkan/vulkan.h>

#include "pixfmt.h"
#include "frame.h"
#include "hwcontext.h"

typedef struct AVVkFrame AVVkFrame;

typedef struct AVVulkanDeviceQueueFamily {
    /* Queue family index */
    int idx;
    /* Number of queues in the queue family in use */
    int num;
    /* Queue family capabilities. Must be non-zero.
     * Flags may be removed to indicate the queue family may not be used
     * for a given purpose. */
    VkQueueFlagBits flags;
    /* Vulkan implementations are allowed to list multiple video queues
     * which differ in what they can encode or decode. */
    VkVideoCodecOperationFlagBitsKHR video_caps;
} AVVulkanDeviceQueueFamily;

/**
 * @file
 * API-specific header for AV_HWDEVICE_TYPE_VULKAN.
 *
 * For user-allocated pools, AVHWFramesContext.pool must return AVBufferRefs
 * with the data pointer set to an AVVkFrame.
 */

/**
 * Main Vulkan context, allocated as AVHWDeviceContext.hwctx.
 * All of these can be set before init to change what the context uses
 */
typedef struct AVVulkanDeviceContext {
    /**
     * Custom memory allocator, else NULL
     */
    const VkAllocationCallbacks *alloc;

    /**
     * Pointer to a vkGetInstanceProcAddr loading function.
     * If unset, will dynamically load and use libvulkan.
     */
    PFN_vkGetInstanceProcAddr get_proc_addr;

    /**
     * Vulkan instance. Must be at least version 1.3.
     */
    VkInstance inst;

    /**
     * Physical device
     */
    VkPhysicalDevice phys_dev;

    /**
     * Active device
     */
    VkDevice act_dev;

    /**
     * This structure should be set to the set of features that present and enabled
     * during device creation. When a device is created by FFmpeg, it will default to
     * enabling all that are present of the shaderImageGatherExtended,
     * fragmentStoresAndAtomics, shaderInt64 and vertexPipelineStoresAndAtomics features.
     */
    VkPhysicalDeviceFeatures2 device_features;

    /**
     * Enabled instance extensions.
     * If supplying your own device context, set this to an array of strings, with
     * each entry containing the specified Vulkan extension string to enable.
     * Duplicates are possible and accepted.
     * If no extensions are enabled, set these fields to NULL, and 0 respectively.
     * av_vk_get_optional_instance_extensions() can be used to enumerate extensions
     * that FFmpeg may use if enabled.
     */
    const char * const *enabled_inst_extensions;
    int nb_enabled_inst_extensions;

    /**
     * Enabled device extensions. By default, VK_KHR_external_memory_fd,
     * VK_EXT_external_memory_dma_buf, VK_EXT_image_drm_format_modifier,
     * VK_KHR_external_semaphore_fd and VK_EXT_external_memory_host are enabled if found.
     * If supplying your own device context, these fields takes the same format as
     * the above fields, with the same conditions that duplicates are possible
     * and accepted, and that NULL and 0 respectively means no extensions are enabled.
     * av_vk_get_optional_device_extensions() can be used to enumerate extensions
     * that FFmpeg may use if enabled.
     */
    const char * const *enabled_dev_extensions;
    int nb_enabled_dev_extensions;

#if FF_API_VULKAN_FIXED_QUEUES
    /**
     * Queue family index for graphics operations, and the number of queues
     * enabled for it. If unavailable, will be set to -1. Not required.
     * av_hwdevice_create() will attempt to find a dedicated queue for each
     * queue family, or pick the one with the least unrelated flags set.
     * Queue indices here may overlap if a queue has to share capabilities.
     */
    attribute_deprecated
    int queue_family_index;
    attribute_deprecated
    int nb_graphics_queues;

    /**
     * Queue family index for transfer operations and the number of queues
     * enabled. Required.
     */
    attribute_deprecated
    int queue_family_tx_index;
    attribute_deprecated
    int nb_tx_queues;

    /**
     * Queue family index for compute operations and the number of queues
     * enabled. Required.
     */
    attribute_deprecated
    int queue_family_comp_index;
    attribute_deprecated
    int nb_comp_queues;

    /**
     * Queue family index for video encode ops, and the amount of queues enabled.
     * If the device doesn't support such, queue_family_encode_index will be -1.
     * Not required.
     */
    attribute_deprecated
    int queue_family_encode_index;
    attribute_deprecated
    int nb_encode_queues;

    /**
     * Queue family index for video decode ops, and the amount of queues enabled.
     * If the device doesn't support such, queue_family_decode_index will be -1.
     * Not required.
     */
    attribute_deprecated
    int queue_family_decode_index;
    attribute_deprecated
    int nb_decode_queues;
#endif

#if FF_API_VULKAN_SYNC_QUEUES
    /**
     * Locks a queue, preventing other threads from submitting any command
     * buffers to this queue.
     * If set to NULL, will be set to lavu-internal functions that utilize a
     * mutex.
     *
     * Deprecated: use VK_KHR_internally_synchronized_queues.
     */
    attribute_deprecated
    void (*lock_queue)(struct AVHWDeviceContext *ctx, uint32_t queue_family, uint32_t index);

    /**
     * Similar to lock_queue(), unlocks a queue. Must only be called after locking.
     *
     * Deprecated: use VK_KHR_internally_synchronized_queues.
     */
    attribute_deprecated
    void (*unlock_queue)(struct AVHWDeviceContext *ctx, uint32_t queue_family, uint32_t index);
#endif

    /**
     * Queue families used. Must be preferentially ordered. List may contain
     * duplicates.
     *
     * For compatibility reasons, all the enabled queue families listed above
     * (queue_family_(tx/comp/encode/decode)_index) must also be included in
     * this list until they're removed after deprecation.
     */
    AVVulkanDeviceQueueFamily qf[64];
    int nb_qf;
} AVVulkanDeviceContext;

/**
 * Defines the behaviour of frame allocation.
 */
typedef enum AVVkFrameFlags {
    /* Unless this flag is set, autodetected flags will be OR'd based on the
     * device and tiling during av_hwframe_ctx_init(). */
    AV_VK_FRAME_FLAG_NONE              = (1ULL << 0),

    /* Disables multiplane images.
     * This is required to export/import images from CUDA. */
    AV_VK_FRAME_FLAG_DISABLE_MULTIPLANE = (1ULL << 2),
} AVVkFrameFlags;

/**
 * Allocated as AVHWFramesContext.hwctx, used to set pool-specific options
 */
typedef struct AVVulkanFramesContext {
    /**
     * Controls the tiling of allocated frames.
     * If left as VK_IMAGE_TILING_OPTIMAL (0), will use optimal tiling.
     * Can be set to VK_IMAGE_TILING_LINEAR to force linear images,
     * or VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT to force DMABUF-backed
     * images.
     * @note Imported frames from other APIs ignore this.
     */
    VkImageTiling tiling;

    /**
     * Defines extra usage of output frames. If non-zero, all flags MUST be
     * supported by the VkFormat. Regardless, frames will always have the
     * following usage flags enabled, if supported by the format:
     * - VK_IMAGE_USAGE_SAMPLED_BIT
     * - VK_IMAGE_USAGE_STORAGE_BIT
     * - VK_IMAGE_USAGE_TRANSFER_SRC_BIT
     * - VK_IMAGE_USAGE_TRANSFER_DST_BIT
     */
    VkImageUsageFlagBits usage;

    /**
     * Extension data for image creation.
     * If DRM tiling is used, a VkImageDrmFormatModifierListCreateInfoEXT structure
     * can be added to specify the exact modifier to use.
     *
     * Additional structures may be added at av_hwframe_ctx_init() time,
     * which will be freed automatically on uninit(), so users must only free
     * any structures they've allocated themselves.
     */
    void *create_pnext;

    /**
     * Extension data for memory allocation. Must have as many entries as
     * the number of planes of the sw_format.
     * This will be chained to VkExportMemoryAllocateInfo, which is used
     * to make all pool images exportable to other APIs if the necessary
     * extensions are present in enabled_dev_extensions.
     */
    void *alloc_pnext[AV_NUM_DATA_POINTERS];

    /**
     * A combination of AVVkFrameFlags. Unless AV_VK_FRAME_FLAG_NONE is set,
     * autodetected flags will be OR'd based on the device and tiling during
     * av_hwframe_ctx_init().
     */
    AVVkFrameFlags flags;

    /**
     * Flags to set during image creation. If unset, defaults to
     * VK_IMAGE_CREATE_ALIAS_BIT.
     */
    VkImageCreateFlags img_flags;

    /**
     * Vulkan format for each image. MUST be compatible with the pixel format.
     * If unset, will be automatically set.
     * There are at most two compatible formats for a frame - a multiplane
     * format, and a single-plane multi-image format.
     */
    VkFormat format[AV_NUM_DATA_POINTERS];

    /**
     * Number of layers each image will have.
     */
    int nb_layers;

    /**
     * Locks a frame, preventing other threads from changing frame properties.
     * Users SHOULD only ever lock just before command submission in order
     * to get accurate frame properties, and unlock immediately after command
     * submission without waiting for it to finish.
     *
     * If unset, will be set to lavu-internal functions that utilize a mutex.
     */
    void (*lock_frame)(struct AVHWFramesContext *fc, AVVkFrame *vkf);

    /**
     * Similar to lock_frame(), unlocks a frame. Must only be called after locking.
     */
    void (*unlock_frame)(struct AVHWFramesContext *fc, AVVkFrame *vkf);
} AVVulkanFramesContext;

/*
 * Frame structure.
 *
 * @note the size of this structure is not part of the ABI, to allocate
 * you must use @av_vk_frame_alloc().
 */
struct AVVkFrame {
    /**
     * Vulkan images to which the memory is bound to.
     * May be one for multiplane formats, or multiple.
     */
    VkImage img[AV_NUM_DATA_POINTERS];

    /**
     * Tiling for the frame.
     */
    VkImageTiling tiling;

    /**
     * Memory backing the images. Either one, or as many as there are planes
     * in the sw_format.
     * In case of having multiple VkImages, but one memory, the offset field
     * will indicate the bound offset for each image.
     */
    VkDeviceMemory mem[AV_NUM_DATA_POINTERS];
    size_t size[AV_NUM_DATA_POINTERS];

    /**
     * OR'd flags for all memory allocated
     */
    VkMemoryPropertyFlagBits flags;

    /**
     * Updated after every barrier. One per VkImage.
     */
    VkAccessFlagBits access[AV_NUM_DATA_POINTERS];
    VkImageLayout layout[AV_NUM_DATA_POINTERS];

    /**
     * Synchronization timeline semaphores, one for each VkImage.
     * Must not be freed manually. Must be waited on at every submission using
     * the value in sem_value, and must be signalled at every submission,
     * using an incremented value.
     */
    VkSemaphore sem[AV_NUM_DATA_POINTERS];

    /**
     * Up to date semaphore value at which each image becomes accessible.
     * One per VkImage.
     * Clients must wait on this value when submitting a command queue,
     * and increment it when signalling.
     */
    uint64_t sem_value[AV_NUM_DATA_POINTERS];

    /**
     * Internal data.
     */
    struct AVVkFrameInternal *internal;

    /**
     * Describes the binding offset of each image to the VkDeviceMemory.
     * One per VkImage.
     */
    ptrdiff_t offset[AV_NUM_DATA_POINTERS];

    /**
     * Queue family of the images. Must be VK_QUEUE_FAMILY_IGNORED if
     * the image was allocated with the CONCURRENT concurrency option.
     * One per VkImage.
     */
    uint32_t queue_family[AV_NUM_DATA_POINTERS];
};

/**
 * Allocates a single AVVkFrame and initializes everything as 0.
 * @note Must be freed via av_free()
 */
AVVkFrame *av_vk_frame_alloc(void);

/**
 * Returns the optimal per-plane Vulkan format for a given sw_format,
 * one for each plane.
 * Returns NULL on unsupported formats.
 */
const VkFormat *av_vkfmt_from_pixfmt(enum AVPixelFormat p);

/**
 * Returns an array of optional Vulkan instance extensions that FFmpeg
 * may use if enabled.
 * @note Must be freed via av_free()
 */
const char **av_vk_get_optional_instance_extensions(int *count);

/**
 * Returns an array of optional Vulkan device extensions that FFmpeg
 * may use if enabled.
 * @note Must be freed via av_free()
 */
const char **av_vk_get_optional_device_extensions(int *count);

#endif /* AVUTIL_HWCONTEXT_VULKAN_H */
