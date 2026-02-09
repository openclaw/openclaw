---
summary: "Khám phá: cấu hình mô hình, hồ sơ xác thực và hành vi dự phòng"
read_when:
  - Khám phá các ý tưởng tương lai về lựa chọn mô hình + hồ sơ xác thực
title: "Khám phá cấu hình mô hình"
---

# Cấu hình mô hình (Khám phá)

Tài liệu này ghi lại **các ý tưởng** cho cấu hình model trong tương lai. Đối với hành vi hiện tại, xem: Đối với hành vi hiện tại, xem:

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Động lực

Nhà vận hành muốn:

- Nhiều hồ sơ xác thực cho mỗi nhà cung cấp (cá nhân so với công việc).
- Lựa chọn `/model` đơn giản với cơ chế dự phòng có thể dự đoán.
- Phân tách rõ ràng giữa các mô hình văn bản và các mô hình có khả năng xử lý hình ảnh.

## Hướng đi khả dĩ (mức cao)

- Giữ việc lựa chọn mô hình đơn giản: `provider/model` với các bí danh tùy chọn.
- Cho phép nhà cung cấp có nhiều hồ sơ xác thực, với thứ tự rõ ràng.
- Sử dụng danh sách dự phòng toàn cục để tất cả các phiên chuyển đổi dự phòng nhất quán.
- Chỉ ghi đè định tuyến hình ảnh khi được cấu hình rõ ràng.

## Câu hỏi mở

- Việc xoay vòng hồ sơ nên theo từng nhà cung cấp hay theo từng mô hình?
- Giao diện người dùng nên hiển thị việc chọn hồ sơ cho một phiên như thế nào?
- Lộ trình di chuyển an toàn nhất từ các khóa cấu hình kế thừa là gì?
