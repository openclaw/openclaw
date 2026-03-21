# 图片处理工具参考

## Pillow (PIL)

Python 图像处理标准库。

### 基础操作

```python
from PIL import Image

img = Image.open("input.png")        # 打开图片
img.show()                           # 显示图片
print(img.size, img.mode)            # (宽, 高), "RGB"/"RGBA"/"L"

# 另存
img.save("output.jpg")               # 格式自动按扩展名
img.save("output.jpg", quality=85)    # 压缩
img.save("output.png", optimize=True) # 优化压缩
```

### 裁剪

```python
# (left, upper, right, lower) — 像素坐标
cropped = img.crop((100, 100, 400, 400))
cropped.save("cropped.png")
```

### 缩放

```python
# 按尺寸
resized = img.resize((800, 600))    # (宽, 高)

# 按比例（缩放50%）
w, h = img.size
resized = img.resize((int(w * 0.5), int(h * 0.5)))

# 缩略图（原地修改）
img.thumbnail((200, 200))           # 保持宽高比，最大边200px
```

### 格式转换

```python
img_rgb = img.convert("RGB")         # RGBA → RGB（用于 JPEG）
img_rgb.save("output.jpg")

img_gray = img.convert("L")         # 转灰度
img_gray.save("output_gray.jpg")
```

### 旋转和翻转

```python
rotated = img.rotate(90)             # 顺时针旋转90度
rotated = img.rotate(180)
flipped_h = img.transpose(Image.FLIP_LEFT_RIGHT)   # 水平翻转
flipped_v = img.transpose(Image.FLIP_TOP_BOTTOM)   # 垂直翻转
```

### 添加文字水印

```python
from PIL import ImageDraw, ImageFont

draw = ImageDraw.Draw(img)
# 白色文字水印
draw.text((10, 10), "Watermark", fill=(255, 255, 255))

# 较大字号（使用默认字体）
draw.text((50, img.height - 50), "Copyright", fill=(200, 200, 200))

img.save("watermarked.jpg")
```

### 批量处理

```python
import os
from PIL import Image

input_dir  = "C:\\Users\\Administrator\\Desktop\\images\\"
output_dir = "C:\\Users\\Administrator\\Desktop\\images_out\\"
os.makedirs(output_dir, exist_ok=True)

for filename in os.listdir(input_dir):
    if filename.lower().endswith((".jpg", ".png", ".jpeg")):
        img = Image.open(os.path.join(input_dir, filename))
        img.thumbnail((800, 800))
        img.save(os.path.join(output_dir, filename), quality=80)
        print(f"处理完成: {filename}")
```

### 图像合成（拼接）

```python
from PIL import Image
import os

# 拼接多张图片（横向）
images = [Image.open(f"img_{i}.png") for i in range(1, 5)]
 widths, heights = zip(*(i.size for i in images))
total_width = sum(widths)
max_height  = max(heights)

new_img = Image.new("RGB", (total_width, max_height), (255, 255, 255))
x_offset = 0
for im in images:
    new_img.paste(im, (x_offset, 0))
    x_offset += im.width

new_img.save("combined.png")
```
