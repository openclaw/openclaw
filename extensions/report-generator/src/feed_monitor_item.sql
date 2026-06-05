-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- 主机： localhost
-- 生成日期： 2026-05-11 02:37:03
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
-- 表的结构 `feed_monitor_item`
--

CREATE TABLE `feed_monitor_item` (
  `id` int NOT NULL,
  `refId` int NOT NULL DEFAULT '0',
  `duplicated` tinyint(1) NOT NULL DEFAULT '0',
  `center` tinyint(1) NOT NULL DEFAULT '0',
  `labelCenter` tinyint(1) NOT NULL DEFAULT '0',
  `eventCenter` tinyint(1) NOT NULL DEFAULT '0',
  `topicId` mediumint NOT NULL,
  `slaveTopicId` mediumint NOT NULL DEFAULT '0',
  `clusterId` int NOT NULL DEFAULT '0',
  `labelClusterId` int NOT NULL DEFAULT '0',
  `eventClusterId` int NOT NULL DEFAULT '0',
  `score` float NOT NULL DEFAULT '0',
  `similarity` float NOT NULL DEFAULT '0',
  `labelSimilarity` float NOT NULL DEFAULT '0',
  `eventSimilarity` float NOT NULL DEFAULT '0',
  `author` varchar(480) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reporter` varchar(480) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `original` tinyint(1) NOT NULL DEFAULT '0',
  `originalRelease` tinyint(1) NOT NULL DEFAULT '0',
  `official` tinyint(1) NOT NULL DEFAULT '0',
  `officialLevel` tinyint NOT NULL DEFAULT '10',
  `mediaLevel` enum('Central','Local','Government','Institute','Enterprise','Other') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `contentType` enum('Article','Video','Comment') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT 'Article',
  `fansNumber` int NOT NULL DEFAULT '0',
  `comment` tinyint(1) NOT NULL DEFAULT '0',
  `platform` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `platformType` varchar(16) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `originType` varchar(40) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `topicInteractionCount` int NOT NULL DEFAULT '0' COMMENT '互动量',
  `readCount` int NOT NULL DEFAULT '0' COMMENT '阅读量',
  `comments` int NOT NULL DEFAULT '0' COMMENT '评论量',
  `forwardNumber` int NOT NULL DEFAULT '0' COMMENT '转发量',
  `praiseNum` int NOT NULL DEFAULT '0' COMMENT '点赞量',
  `favouritesCount` int NOT NULL DEFAULT '0' COMMENT '收藏量',
  `city` varchar(60) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `cityInContent` varchar(60) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `video` tinyint(1) NOT NULL DEFAULT '0',
  `link` varchar(1000) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `emotion` enum('Positive','Neutral','Negative') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `date` datetime DEFAULT NULL,
  `level` enum('Red','Orange','Yellow','Blue') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT 'Blue',
  `updateDate` datetime DEFAULT NULL,
  `reported` tinyint(1) NOT NULL DEFAULT '0',
  `pushedDaily` tinyint(1) NOT NULL DEFAULT '0',
  `pushedWeekly` tinyint(1) NOT NULL DEFAULT '0',
  `pushedMonthly` tinyint(1) NOT NULL DEFAULT '0',
  `realtimePushed` tinyint(1) NOT NULL DEFAULT '0',
  `skip` tinyint(1) NOT NULL DEFAULT '0',
  `visible` tinyint(1) NOT NULL DEFAULT '0',
  `reportAnalyzed` tinyint(1) NOT NULL DEFAULT '0',
  `vectored` tinyint(1) NOT NULL DEFAULT '0',
  `fullVectored` tinyint(1) NOT NULL DEFAULT '0',
  `labelVectored` tinyint(1) NOT NULL DEFAULT '0',
  `eventVectored` tinyint NOT NULL DEFAULT '0',
  `checked` tinyint(1) NOT NULL DEFAULT '0',
  `doubleChecked` tinyint(1) NOT NULL DEFAULT '0',
  `remarked` tinyint(1) NOT NULL DEFAULT '0',
  `offline` tinyint(1) NOT NULL DEFAULT '0',
  `pushed` tinyint(1) NOT NULL DEFAULT '0',
  `manually` tinyint(1) NOT NULL DEFAULT '0',
  `amended` tinyint(1) NOT NULL DEFAULT '0',
  `actionable` tinyint(1) NOT NULL DEFAULT '0',
  `reanalyze` enum('NotFound','Pending','Done') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT 'NotFound',
  `reanalyzeGroup` mediumint NOT NULL DEFAULT '0',
  `analysisId` int NOT NULL DEFAULT '0',
  `fixed` tinyint(1) NOT NULL DEFAULT '0',
  `labelVectorImported` tinyint(1) NOT NULL DEFAULT '0',
  `vectorImported` tinyint(1) DEFAULT '0',
  `masterStatus` enum('待办','已办','待阅','已阅') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `slaveStatus` enum('待办','已办') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `simhashimport` tinyint(1) NOT NULL DEFAULT '0',
  `poSystem` enum('Sina','Qingbo','Xiaoying','SearchEngine','DaZhong') COLLATE utf8mb4_unicode_ci DEFAULT 'Xiaoying'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- 转储表的索引
--

--
-- 表的索引 `feed_monitor_item`
--
ALTER TABLE `feed_monitor_item`
  ADD PRIMARY KEY (`id`),
  ADD KEY `refId` (`refId`),
  ADD KEY `date` (`date`),
  ADD KEY `topicId` (`topicId`,`emotion`,`level`),
  ADD KEY `slaveTopicId` (`slaveTopicId`,`emotion`,`level`),
  ADD KEY `fullVectored` (`fullVectored`),
  ADD KEY `cluster` (`clusterId`),
  ADD KEY `idx_topic_skip_date` (`topicId`,`skip`,`date` DESC),
  ADD KEY `topic_clusterId` (`topicId`,`clusterId`,`date`) USING BTREE,
  ADD KEY `labelVectored` (`labelVectored`),
  ADD KEY `fixed` (`fixed`),
  ADD KEY `labelClusterId` (`labelClusterId`),
  ADD KEY `topicLabelClusterDate` (`topicId`,`labelClusterId`,`date`),
  ADD KEY `labelVectorImported` (`labelVectorImported`),
  ADD KEY `vectorImported` (`vectorImported`),
  ADD KEY `eventVectored` (`eventVectored`),
  ADD KEY `idx_slave_topic_event_cluster` (`slaveTopicId`,`eventClusterId`,`date`),
  ADD KEY `slave_cluster` (`clusterId`,`date`),
  ADD KEY `idx_topic_pushed` (`topicId`,`pushed`,`date`),
  ADD KEY `idx_remarked` (`topicId`,`emotion`,`remarked`,`date`),
  ADD KEY `idx_offline` (`topicId`,`offline`,`date`),
  ADD KEY `idx_topic_event_cluster` (`topicId`,`eventClusterId`,`date`,`id`) USING BTREE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
