-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- 主机： localhost
-- 生成日期： 2026-05-11 02:38:32
-- 服务器版本： 8.0.45-0ubuntu0.22.04.1
-- PHP 版本： 8.2.29

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- 数据库： `superworker`
--

-- --------------------------------------------------------

--
-- 表的结构 `feed_monitor_item_data`
--

CREATE TABLE `feed_monitor_item_data` (
  `id` int NOT NULL,
  `author` varchar(480) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `reporter` varchar(480) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `title` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `titleClean` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `keywords` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `keySentences` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `summary` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `eventDate` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `result` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
) ;

--
-- 转储表的索引
--

--
-- 表的索引 `feed_monitor_item_data`
--
ALTER TABLE `feed_monitor_item_data`
  ADD PRIMARY KEY (`id`);
ALTER TABLE `feed_monitor_item_data` ADD FULLTEXT KEY `ft_search_index` (`title`,`author`,`summary`,`content`);
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
